import path from "node:path";

import {
  migrateDatabase,
  projectRegistrationLocationExists,
  reconcileStagedAssets,
  WORKSPACE_LEASE_RENEW_MS,
} from "@vidcom/adapter";
import {
  bootstrapProject,
  reconcilePendingMutations,
  type AbsolutePath,
  type ProjectRef,
} from "@vidcom/core";

import { createApplication, createInfrastructure, hashContent, type CompositionRootConfig } from "./composition-root";

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
export async function runStartupSequence<Listener>(steps: StartupSteps<Listener>): Promise<Listener> {
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
    try { await step(); }
    catch (cause) { throw new StartupError(name, { cause }); }
  }
  try { return await steps.listener(); }
  catch (cause) { throw new StartupError("listener", { cause }); }
}

export interface DaemonRuntime {
  infrastructure: ReturnType<typeof createInfrastructure>;
  application: ReturnType<typeof createApplication> | null;
}

export interface DaemonHooks<Listener> {
  recoverJobs(runtime: DaemonRuntime): Promise<void>;
  startScheduler(runtime: DaemonRuntime): Promise<{ stop(): Promise<void> | void } | void>;
  startWatcher(runtime: DaemonRuntime): Promise<{ close(): Promise<void> | void } | void>;
  openListener(runtime: unknown): Promise<Listener>;
  onLeaseLost?(runtime: DaemonRuntime): Promise<void> | void;
}

async function closeListener(listener: unknown): Promise<void> {
  if (listener && typeof (listener as { close?: unknown }).close === "function") {
    await (listener as { close(): Promise<void> | void }).close();
  }
}

export async function startVidcomFoundation<Listener>(
  config: CompositionRootConfig & { holderId: string },
  hooks: DaemonHooks<Listener>,
) {
  const infrastructure = createInfrastructure(config);
  let leaseId: string | null = null;
  let leaseRenewal: ReturnType<typeof setInterval> | null = null;
  let application: ReturnType<typeof createApplication> | null = null;
  let schedulerHandle: { stop(): Promise<void> | void } | null = null;
  let watcherHandle: { close(): Promise<void> | void } | null = null;
  let listenerHandle: Listener | null = null;
  let leaseLost = false;
  const stopBackground = async () => {
    await watcherHandle?.close();
    await schedulerHandle?.stop();
  };
  try {
    const listener = await runStartupSequence({
      migration: () => migrateDatabase(infrastructure.database),
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
            await hooks.onLeaseLost?.({ infrastructure, application });
          })
          .catch(async () => {
            if (leaseLost) return;
            leaseLost = true;
            if (leaseRenewal) clearInterval(leaseRenewal);
            await stopBackground();
            await hooks.onLeaseLost?.({ infrastructure, application });
          }), WORKSPACE_LEASE_RENEW_MS);
        leaseRenewal.unref?.();
        application = createApplication(infrastructure, leaseId);
      },
      reconciliation: async () => {
        await reconcileStagedAssets(infrastructure.database, infrastructure.clock, config.appDataRoot);
        await reconcilePendingMutations({
          workspace: infrastructure.workspace,
          journal: infrastructure.journal,
          resolveProjectRef: async (projectId): Promise<ProjectRef | null> => {
            const live = await infrastructure.workspace.readProjectRef(projectId);
            if (live) return live;
            const registration = await infrastructure.journal.findProjectRegistration(projectId);
            return registration
              ? {
                  id: projectId,
                  slug: registration.slug,
                  root: path.join(registration.workspaceRoot, registration.slug) as AbsolutePath,
                  entry: "index.html" as ProjectRef["entry"],
                }
              : null;
          },
        });
      },
      jobRecovery: () => hooks.recoverJobs({ infrastructure, application }),
      identityBackfill: async () => {
        if (!application) throw new Error("application was not initialized after lease acquisition");
        for (const candidate of await infrastructure.workspace.listProjectCandidates()) {
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
      scheduler: async () => { schedulerHandle = await hooks.startScheduler({ infrastructure, application }) ?? null; },
      watcher: async () => { watcherHandle = await hooks.startWatcher({ infrastructure, application }) ?? null; },
      listener: async () => { listenerHandle = await hooks.openListener({ infrastructure, application }); return listenerHandle; },
    });
    return {
      infrastructure,
      application: application!,
      listener,
      async stop() {
        if (leaseRenewal) clearInterval(leaseRenewal);
        await closeListener(listenerHandle);
        await stopBackground();
        if (leaseId) await infrastructure.lease.release(leaseId);
        await infrastructure.database.destroy();
      },
    };
  } catch (error) {
    if (leaseRenewal) clearInterval(leaseRenewal);
    await closeListener(listenerHandle).catch(() => {});
    await stopBackground().catch(() => {});
    if (leaseId) await infrastructure.lease.release(leaseId).catch(() => {});
    await infrastructure.database.destroy();
    throw error;
  }
}
