import {
  migrateDatabase,
  projectRegistrationLocationExists,
  reconcileStagedAssets,
  scavengeTtsScratch,
  WORKSPACE_LEASE_RENEW_MS,
} from "@vidcom/adapter";
import {
  bootstrapProject,
  reconcileCompositeMutations,
} from "@vidcom/core";

import { createApplication, createInfrastructure, hashContent, type CompositionRootConfig } from "./composition-root";
import { createLifecycleHandle } from "./foundation-lifecycle";

/**
 * 1 hour. Long enough that a legitimately slow batch in another daemon is never
 * swept out from under it, short enough that a crash's leftovers do not survive
 * a working day.
 */
const TTS_SCRATCH_GRACE_MS = 60 * 60 * 1_000;

export type StartupStepName =
  | "migration"
  | "lease"
  | "reconciliation"
  | "job-recovery"
  | "identity-backfill"
  | "scheduler"
  | "watcher"
  | "listener";

export class StartupError extends Error {
  constructor(readonly step: StartupStepName, options: { cause: unknown }) {
    super(`VidCom startup failed during ${step}`, options);
    this.name = "StartupError";
  }
}

export interface StartupSteps<Listener = unknown> {
  migration(): Promise<void>;
  lease(): Promise<void>;
  reconciliation(): Promise<void>;
  jobRecovery(): Promise<void>;
  identityBackfill(): Promise<void>;
  scheduler(): Promise<void>;
  watcher(): Promise<void>;
  listener(): Promise<Listener>;
}

/** Executes the reviewed startup DAG as a strict sequence; no listener is opened early. */
export async function runStartupSequence<Listener>(
  steps: StartupSteps<Listener>,
  signal?: AbortSignal,
): Promise<Listener> {
  const ordered: Array<[StartupStepName, () => Promise<unknown>]> = [
    ["migration", steps.migration],
    ["lease", steps.lease],
    ["reconciliation", steps.reconciliation],
    ["job-recovery", steps.jobRecovery],
    ["identity-backfill", steps.identityBackfill],
    ["scheduler", steps.scheduler],
    ["watcher", steps.watcher],
  ];
  for (const [name, step] of ordered) {
    signal?.throwIfAborted();
    try { await step(); }
    catch (cause) { throw new StartupError(name, { cause }); }
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
  try {
    const listener = await steps.listener();
    signal?.throwIfAborted();
    return listener;
  }
  catch (cause) { throw new StartupError("listener", { cause }); }
}

export interface DaemonRuntime {
  infrastructure: ReturnType<typeof createInfrastructure>;
  application: ReturnType<typeof createApplication> | null;
  /** Current foundation lease, exposed only for bounded lease-loss recovery. */
  leaseId: string | null;
}

export interface DaemonHooks<Listener> {
  recoverJobs(runtime: DaemonRuntime): Promise<void>;
  startScheduler(runtime: DaemonRuntime): Promise<{ stop(): Promise<void> | void } | void>;
  startWatcher(runtime: DaemonRuntime): Promise<{ close(): Promise<void> | void } | void>;
  openListener(runtime: DaemonRuntime): Promise<Listener>;
  onLeaseLost?(runtime: DaemonRuntime): Promise<void> | void;
}

async function recoverRenderRoots(infrastructure: ReturnType<typeof createInfrastructure>): Promise<void> {
  const running = new Set(await infrastructure.jobs.listRunningIds());
  const result = await infrastructure.renderRoots.reclaimOrphans(infrastructure.clock.now(), running);
  for (const jobId of result.reclaimedJobIds) {
    await infrastructure.jobs.clearCleanupPending(jobId);
  }
  const reclaimed = new Set(result.reclaimedJobIds);
  for (const jobId of await infrastructure.jobs.listCleanupPendingIds()) {
    if (reclaimed.has(jobId)) continue;
    const ownership = await infrastructure.renderRoots.inspect(jobId);
    if (ownership === "absent") {
      await infrastructure.jobs.clearCleanupPending(jobId);
    } else if (ownership === "unowned") {
      infrastructure.logger.warn(
        "render root cleanup remains pending because ownership is invalid",
        { jobId },
      );
    }
  }
  if (result.errors.length > 0) {
    throw new AggregateError(
      result.errors.map(({ root, reason }) => new Error(`${root}: ${reason}`)),
      "one or more render roots could not be reclaimed",
    );
  }
}

async function recoverJobsAndRenderRoots(
  runtime: DaemonRuntime,
  recoverJobs: DaemonHooks<unknown>["recoverJobs"],
): Promise<void> {
  const errors: unknown[] = [];
  if (runtime.application) {
    try {
      await runtime.application.workspaceCoordinator.recoverPending(runtime.infrastructure.workspaceRoot);
    } catch (error) { errors.push(error); }
  }
  try { await recoverJobs(runtime); }
  catch (error) { errors.push(error); }
  try { await recoverRenderRoots(runtime.infrastructure); }
  catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "VidCom job recovery failed");
}

async function closeListener(listener: unknown): Promise<void> {
  if (listener && typeof (listener as { close?: unknown }).close === "function") {
    await (listener as { close(): Promise<void> | void }).close();
  }
}

async function runCleanupActions(
  actions: ReadonlyArray<() => Promise<void>>,
  message: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try { await action(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, message);
}

export async function startVidcomFoundation<Listener>(
  config: CompositionRootConfig & { holderId: string },
  hooks: DaemonHooks<Listener>,
  options: {
    signal?: AbortSignal;
    /** BootstrapCoordinator already migrated this app-data during this boot. */
    migrationPrepared?: boolean;
    /** Test seam used to count the real migration call across the whole boot. */
    migrate?: typeof migrateDatabase;
  } = {},
) {
  const infrastructure = createInfrastructure(config);
  let leaseId: string | null = null;
  let leaseRenewal: ReturnType<typeof setInterval> | null = null;
  let application: ReturnType<typeof createApplication> | null = null;
  let schedulerHandle: { stop(): Promise<void> | void } | null = null;
  let watcherHandle: { close(): Promise<void> | void } | null = null;
  let listenerHandle: Listener | null = null;
  let leaseLost = false;
  let listenerClosePromise: Promise<void> | null = null;
  let schedulerStopPromise: Promise<void> | null = null;
  let watcherClosePromise: Promise<void> | null = null;
  let leaseReleasePromise: Promise<void> | null = null;
  let databaseDestroyPromise: Promise<void> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const closeListenerOnce = () => {
    if (!listenerHandle) return Promise.resolve();
    return listenerClosePromise ??= Promise.resolve().then(() => closeListener(listenerHandle));
  };
  const stopSchedulerOnce = () => {
    if (!schedulerHandle) return Promise.resolve();
    return schedulerStopPromise ??= Promise.resolve().then(() => schedulerHandle!.stop());
  };
  const closeWatcherOnce = () => {
    if (!watcherHandle) return Promise.resolve();
    return watcherClosePromise ??= Promise.resolve().then(() => watcherHandle!.close());
  };
  const releaseLeaseOnce = () => {
    if (!leaseId) return Promise.resolve();
    return leaseReleasePromise ??= infrastructure.lease.release(leaseId);
  };
  const destroyDatabaseOnce = () => databaseDestroyPromise ??= infrastructure.database.destroy();
  const stopBackground = () => runCleanupActions(
    [stopSchedulerOnce, closeWatcherOnce],
    "VidCom background shutdown failed",
  );
  // One handle rather than five hand-rolled once-only wrappers. The ordering is
  // unchanged; what the handle adds is that "each step at most once, and a
  // failing step does not cancel the rest" is stated in one tested place
  // instead of re-derived at each call site.
  const lifecycle = createLifecycleHandle([
    { name: "listener", run: closeListenerOnce },
    { name: "scheduler", run: stopSchedulerOnce },
    { name: "watcher", run: closeWatcherOnce },
    { name: "lease", run: releaseLeaseOnce },
    // Recovery entry ids are session-scoped capabilities. Once this foundation
    // stops, keeping them resolvable would let a stale UI address the workspace
    // that has just been replaced.
    { name: "entry-registry", run: () => infrastructure.entries.clear() },
    { name: "database", run: destroyDatabaseOnce },
  ]);
  const cleanup = () => cleanupPromise ??= (async () => {
    if (leaseRenewal) {
      clearInterval(leaseRenewal);
      leaseRenewal = null;
    }
    await lifecycle.stop();
  })();
  try {
    const listener = await runStartupSequence({
      migration: options.migrationPrepared === true
        ? () => Promise.resolve()
        : () => (options.migrate ?? migrateDatabase)(infrastructure.database),
      lease: async () => {
        const acquired = await infrastructure.lease.acquire(config.workspaceRoot, config.holderId);
        if (!acquired.ok) throw new Error(`workspace is held by ${acquired.heldBy.holderId}`);
        leaseId = acquired.leaseId;
        leaseRenewal = setInterval(() => void infrastructure.lease.renew(acquired.leaseId)
          .then(async (held) => {
            if (held || leaseLost) return;
            leaseLost = true;
            if (leaseRenewal) clearInterval(leaseRenewal);
            await stopBackground();
            await hooks.onLeaseLost?.({ infrastructure, application, leaseId });
          })
          .catch(async () => {
            if (leaseLost) return;
            leaseLost = true;
            if (leaseRenewal) clearInterval(leaseRenewal);
            await stopBackground();
            await hooks.onLeaseLost?.({ infrastructure, application, leaseId });
          }), WORKSPACE_LEASE_RENEW_MS);
        leaseRenewal.unref?.();
        application = createApplication(infrastructure, leaseId);
      },
      reconciliation: async () => {
        await reconcileStagedAssets(infrastructure.database, infrastructure.clock, config.appDataRoot);
        await reconcileCompositeMutations({
          workspace: infrastructure.workspace,
          journal: infrastructure.journal,
          workspaceRoot: config.workspaceRoot,
          resolveProjectRef: infrastructure.resolveProjectRef,
          recordFailure: (audit, reason) => infrastructure.toolAudit.recordPendingFailure(audit, reason),
        });
        await infrastructure.largeContent.cleanupUnreferenced(
          await infrastructure.journal.listPreviousObjectHashes(),
          new Date(infrastructure.clock.now().getTime()
            - infrastructure.runtimeConfig.backupOrphanGraceMs),
        );
        await infrastructure.backups.prunePayloads(new Date(
          infrastructure.clock.now().getTime()
            - infrastructure.runtimeConfig.backupPayloadRetentionMs,
        ));
        await infrastructure.backups.cleanupOrphanPayloads(new Date(
          infrastructure.clock.now().getTime()
            - infrastructure.runtimeConfig.backupOrphanGraceMs,
        ));
        await infrastructure.approvalAdmin.cleanupTerminal(
          new Date(infrastructure.clock.now().getTime() - infrastructure.runtimeConfig.approvalRetentionMs),
        );
        // A killed daemon skips the scratch cleanup in `withTtsScratch`, leaving
        // the user's narration text and its raw audio in app-data forever. The
        // grace window keeps this from deleting a batch a second daemon owns.
        await scavengeTtsScratch(
          infrastructure.ttsScratchRoot,
          new Date(infrastructure.clock.now().getTime() - TTS_SCRATCH_GRACE_MS),
        );
      },
      jobRecovery: () => recoverJobsAndRenderRoots(
        { infrastructure, application, leaseId },
        hooks.recoverJobs,
      ),
      identityBackfill: async () => {
        if (!application) throw new Error("application was not initialized after lease acquisition");
        for (const candidate of await infrastructure.workspace.listProjectCandidates()) {
          const identity = await infrastructure.workspace.statWorkspaceFile?.(candidate.root, "vidcom.json") ?? null;
          if (!identity) continue;
          const result = await bootstrapProject({
            workspace: infrastructure.workspace,
            journal: infrastructure.journal,
            authority: application.authority,
            clock: infrastructure.clock,
            ids: infrastructure.ids,
            hashContent,
            registrationLocationExists: projectRegistrationLocationExists,
          }, candidate);
          if (!result.ok) throw new Error(result.error.message);
        }
      },
      scheduler: async () => { schedulerHandle = await hooks.startScheduler({ infrastructure, application, leaseId }) ?? null; },
      watcher: async () => { watcherHandle = await hooks.startWatcher({ infrastructure, application, leaseId }) ?? null; },
      listener: async () => { listenerHandle = await hooks.openListener({ infrastructure, application, leaseId }); return listenerHandle; },
    }, options.signal);
    return {
      infrastructure,
      application: application!,
      leaseId,
      listener,
      stop: cleanup,
    };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) {
      const cleanupErrors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupErrors],
        "VidCom startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
