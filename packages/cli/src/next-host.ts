import path from "node:path";

import {
  AttachmentRegistry,
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  type ServerAppDependencies,
} from "@vidcom/server";
import {
  AppSettingsStore,
  NodePtyAgentTerminals,
  WorkerFilesystemBrowser,
  ensureVidcomSettingsFile,
  migrateDatabase,
  nodeSchedulerTimers,
  readVidcomSettings,
  type RuntimePaths,
  type VidcomDatabase,
} from "@vidcom/adapter";
import type { AbsolutePath, JobId, McpServerDescriptor } from "@vidcom/core";
import { canonicalizeJson, JobScheduler, type ProjectIdentity } from "@vidcom/core";
import { createMcpHttpHandlers, InputRequiredSignal } from "@vidcom/mcp";
import { enqueueRenderJob, enqueueSnapshotJob } from "@vidcom/worker";

import { createJobTypes, createMcpRegistry, createSystemClock, hashContent } from "./composition-root";
import { startVidcomFoundation, type DaemonRuntime } from "./startup";
import { BrowseTokenStore, FilesystemBrowserService } from "@vidcom/core";
import { ErrorCode, SUPPORTED_REVISIONS } from "@vidcom/contracts";
import { agentMcpServer } from "./agent-mcp-server";
import { BRIDGE_CREDENTIAL_SETTING } from "./bridge-credential";
import { VIDCOM_VERSION } from "./commands/version";
import { prepareRuntimeForCli, runtimePathsFor } from "./runtime-paths-source";
import { selectWorkspace } from "./workspace-selection";
import { defaultAppDataRoot } from "./app-data-root";
import { createStartProjectImport } from "./project-import-service";
import { handleLeaseLoss } from "./lease-loss";

export { defaultAppDataRoot } from "./app-data-root";

export interface NextHostedRuntime {
  app: ReturnType<typeof createServerApp>;
  foundation: Awaited<ReturnType<typeof startVidcomFoundation<null>>>;
  nonces: InMemoryNonceStore;
  /** Identifies this process for the lifetime of one start, for discovery and handshake. */
  instanceId: string;
  workspaceRoot: AbsolutePath;
  attachments: AttachmentRegistry;
  /** Shared host state survives workspace swaps; foundations do not. */
  readonly hostState: HostedRuntimeState;
}

interface RuntimeGlobal {
  __vidcomNextRuntimes?: Map<number, Promise<NextHostedRuntime>>;
  __vidcomNextApps?: Map<number, Promise<ReturnType<typeof createServerApp>>>;
}

interface HostedRuntimeBoot {
  appDataRoot: string;
  runtimePaths: RuntimePaths;
}

export interface HostedRuntimeRecord {
  workspaceRoot: string;
  instanceId: string;
}

/** Listener/discovery operations owned outside a workspace foundation. */
export interface HostedRuntimeHost {
  replaceDiscovery(previous: HostedRuntimeRecord | null, next: HostedRuntimeRecord): Promise<void>;
  removeDiscovery(runtime: HostedRuntimeRecord): Promise<void>;
  exitHeadless(error: Error): Promise<void>;
}

interface HostedRuntimeState {
  readonly clock: ReturnType<typeof createSystemClock>;
  readonly nonces: InMemoryNonceStore;
  readonly sessions: InMemorySessionStore;
  readonly instanceId: string;
  attachments?: AttachmentRegistry;
  /**
   * Held on the daemon rather than on one workspace foundation: the pty
   * sessions are the user's, and the process that owns them has to be the one
   * that can still kill them after a workspace switch replaced the foundation.
   */
  terminals?: NodePtyAgentTerminals;
  /** Minted once per daemon start and reused across workspace switches, like the sessions above. */
  agentMcp?: McpServerDescriptor;
  activeRuntime: NextHostedRuntime | null;
  switching: boolean;
  host?: HostedRuntimeHost;
}

/**
 * One browse token store per daemon process.
 *
 * The store must be shared: `/v1/system/*` mints the token and
 * `PUT /v1/workspace/active` spends it, and two stores would mean a token
 * minted by the browse could never be redeemed by the activation.
 */
export const hostBrowseTokens = new BrowseTokenStore();

/** The single UI session this host serves; the bridge has its own sessions. */
export const HOST_BROWSE_SESSION = "host";

function browserSessionId(sessions: InMemorySessionStore, request: Request): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  for (const segment of cookies.split(";")) {
    const [name, ...rest] = segment.trim().split("=");
    if (name === "vidcom_session" && rest.length > 0) {
      return sessions.fingerprint(rest.join("="));
    }
  }
  return undefined;
}

/**
 * Directory a packaged build unpacked its native sidecars into, or `undefined`
 * in a source checkout where they sit beside the code.
 *
 * Every production entry point MUST pass this through to the composition root.
 * A SEA binary has no `packages/adapter/sidecars` on disk, so a runtime that
 * omits it falls back to a path relative to the bundle and reports the VieNeu
 * sidecar as missing on exactly the artifact the project ships.
 *
 * `VIDCOM_NATIVE_DEPS` lets the packaging step name the extraction directory;
 * otherwise it is a stable subdirectory of app-data, which is where the
 * extractor writes by default.
 */
export function defaultNativeDependenciesRoot(appDataRoot: string): string {
  return process.env.VIDCOM_NATIVE_DEPS
    ? path.resolve(process.env.VIDCOM_NATIVE_DEPS)
    : path.join(appDataRoot, "native");
}

function runtimeMap(): Map<number, Promise<NextHostedRuntime>> {
  const shared = globalThis as typeof globalThis & RuntimeGlobal;
  return shared.__vidcomNextRuntimes ??= new Map();
}

function appMap(): Map<number, Promise<ReturnType<typeof createServerApp>>> {
  const shared = globalThis as typeof globalThis & RuntimeGlobal;
  return shared.__vidcomNextApps ??= new Map();
}

function setHostedApp(port: number, app: ReturnType<typeof createServerApp>): void {
  appMap().set(port, Promise.resolve(app));
}

function activateHostedRuntime(port: number, runtime: NextHostedRuntime): void {
  const pending = Promise.resolve(runtime);
  runtimeMap().set(port, pending);
  appMap().set(port, pending.then((value) => value.app));
  runtime.hostState.activeRuntime = runtime;
}

export async function startNextHostedRuntime(
  port: number,
  explicitWorkspace?: string,
  options: {
    autoStarted?: boolean;
    boot?: HostedRuntimeBoot;
    database?: VidcomDatabase;
    migrate?: typeof migrateDatabase;
    hostState?: HostedRuntimeState;
    host?: HostedRuntimeHost;
  } = {},
): Promise<NextHostedRuntime> {
  const clock = options.hostState?.clock ?? createSystemClock();
  const nonces = options.hostState?.nonces ?? new InMemoryNonceStore(clock);
  const sessions = options.hostState?.sessions ?? new InMemorySessionStore(clock);
  // A workspace swap stays inside this daemon and keeps its identity; a fresh
  // process gets a fresh id so a stale handshake cannot bind to a restart.
  const instanceId = options.hostState?.instanceId ?? `daemon_${crypto.randomUUID()}`;
  const hostState: HostedRuntimeState = options.hostState ?? {
    clock,
    nonces,
    sessions,
    instanceId,
    activeRuntime: null,
    switching: false,
  };
  if (options.host) hostState.host = options.host;
  if (!options.hostState) {
    const bootstrapNonce = process.env.VIDCOM_BOOTSTRAP_NONCE;
    delete process.env.VIDCOM_BOOTSTRAP_NONCE;
    if (bootstrapNonce) nonces.register(bootstrapNonce);
  }
  let leaseHeld = true;
  // Settings first: the file is allowed to say where application data lives, so
  // nothing that depends on that path can be computed before it is read.
  const settings = await readVidcomSettings();
  const appDataRoot = defaultAppDataRoot(settings);
  await ensureVidcomSettingsFile();
  let workspaceRoot: AbsolutePath;
  let boot = options.boot;
  if (boot) {
    if (path.resolve(boot.appDataRoot) !== path.resolve(appDataRoot)) {
      throw new Error("the active app-data root changed during a workspace switch");
    }
    if (!options.database) {
      throw new Error("a workspace switch must retain the already-migrated database");
    }
    workspaceRoot = await selectWorkspace({
      explicit: explicitWorkspace ?? process.env.VIDCOM_WORKSPACE ?? settings.workspaceRoot,
      appDataRoot,
      database: options.database,
    });
  } else {
    const prepared = await prepareRuntimeForCli(appDataRoot, {
      ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
    });
    try {
      workspaceRoot = await selectWorkspace({
        explicit: explicitWorkspace ?? process.env.VIDCOM_WORKSPACE ?? settings.workspaceRoot,
        appDataRoot,
        database: prepared.database,
      });
      boot = { appDataRoot, runtimePaths: runtimePathsFor(appDataRoot, prepared) };
    } finally {
      await prepared.release();
    }
  }
  let scheduler: JobScheduler | null = null;
  let leaseLossHandler: (runtime: DaemonRuntime) => Promise<void> = async () => {};
  const foundation = await startVidcomFoundation({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    nativeDependenciesRoot: defaultNativeDependenciesRoot(appDataRoot) as AbsolutePath,
    // Complete or not at all. A half-filled set produces paths that look valid
    // and point at nothing, which fails much later and somewhere else.
    runtimePaths: boot.runtimePaths,
    ...(settings.runtime.caBundlePath === null
      ? {}
      : { caBundlePath: settings.runtime.caBundlePath as AbsolutePath }),
    settings,
    holderId: `next:${process.pid}:${crypto.randomUUID()}`,
    clock,
  }, {
    async recoverJobs({ infrastructure, application }) {
      if (!application) throw new Error("application was not initialized before job recovery");
      scheduler = new JobScheduler(
        infrastructure.jobs,
        infrastructure.clock,
        infrastructure.ids,
        createJobTypes(infrastructure, application),
        infrastructure.events,
        nodeSchedulerTimers,
      );
      await scheduler.recoverStale();
    },
    async startScheduler() {
      scheduler?.start();
      return scheduler ? { stop: () => scheduler!.stop() } : undefined;
    },
    async startWatcher({ infrastructure }) {
      await infrastructure.watcher.start();
      return infrastructure.watcher;
    },
    async openListener() { return null; },
    onLeaseLost(runtime) {
      return leaseLossHandler(runtime);
    },
  }, {
    migrationPrepared: true,
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  });
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const projectReads: NonNullable<ServerAppDependencies["projectReads"]> = {
    ...foundation.application.readDependencies,
    runtimeSource: foundation.infrastructure.runtimeSource,
    mimeFromPath: foundation.infrastructure.mimeFromPath,
  };
  const projectWrites: NonNullable<ServerAppDependencies["projectWrites"]> = {
    ...foundation.application.writeDependencies,
    reads: foundation.application.readDependencies,
    bgmSynth: foundation.infrastructure.bgmSynth,
    bgmLibrary: foundation.infrastructure.bgmLibrary,
    bgmProviders: foundation.infrastructure.bgmProviders,
    hashContent,
    mimeFromPath: foundation.infrastructure.mimeFromPath,
  };
  const registry = createMcpRegistry(foundation.infrastructure, foundation.application);
  const mcp = createMcpHttpHandlers(registry);
  const attachments = hostState.attachments ??= new AttachmentRegistry({
    clock,
    instanceId,
    // Only a daemon a client started on demand may retire itself. One a person
    // started stays up until that person stops it, however quiet it gets.
    autoStarted: options.autoStarted ?? false,
    hasActiveWork: () => hostState.activeRuntime?.foundation.infrastructure.jobs.hasNonTerminalJob?.() ?? false,
  });
  const terminals = hostState.terminals ??= new NodePtyAgentTerminals(
    path.join(appDataRoot, "agent-terminals"),
  );
  // Issued per daemon start, not per session: a credential per terminal would
  // leave one row behind for every tab the user ever opened.
  const agentMcp = hostState.agentMcp ??= await agentMcpServer(
    foundation.infrastructure.credentials,
    port,
  );
  const workspaceOverview = async () => {
    const entries = await foundation.application.scanWorkspace();
    return {
      workspaceRoot,
      source: explicitWorkspace ? "explicit" : "active",
      entries: await Promise.all(entries.map(async (entry) => {
        if (entry.kind !== "project" || entry.projectId === null) {
          return { ...entry, thumbnail: await foundation.application.thumbnails.resolve(entry, null, null) };
        }
        const ref = await foundation.infrastructure.workspace.readProjectRef(entry.projectId);
        const state = ref ? await foundation.application.state.readState(ref) : null;
        const thumbnail = await foundation.application.thumbnails.resolve(
          entry, state?.snapshots ?? null, state?.sourceRevision ?? null,
        );
        return {
          ...entry,
          thumbnail,
          ...(thumbnail.kind === "image"
            ? { thumbnailUrl: `/api/v1/projects/${entry.projectId}/assets/${thumbnail.path}` }
            : {}),
        };
      })),
    };
  };
  const enqueueDependencies = {
    workspace: foundation.infrastructure.workspace,
    composition: foundation.infrastructure.composition,
    journal: foundation.infrastructure.journal,
    jobs: foundation.infrastructure.jobs,
    ids: foundation.infrastructure.ids,
    hashContent,
    binaries: foundation.infrastructure.renderBinaries,
    fonts: foundation.application.fonts,
    diagnostics: foundation.application.diagnostics,
  };
  const browser = new FilesystemBrowserService(new WorkerFilesystemBrowser(), hostBrowseTokens);
  const startProjectImport = createStartProjectImport({
    workspaceRoot,
    takenSlugs: async () => (await foundation.application.scanWorkspace()).map((entry) => entry.slug),
    resolveSelection: async (token, sessionId) => {
      if (!sessionId) return null;
      const resolved = await browser.resolveSelection({ sessionId, token });
      if (!resolved.ok) return null;
      const held = hostBrowseTokens.peek(token, sessionId);
      return held ?? null;
    },
    findExisting: async (idempotencyKey) => {
      const find = foundation.infrastructure.jobs.findIdempotent;
      if (!find) throw new TypeError("job store cannot query import idempotency");
      const job = await find.call(
        foundation.infrastructure.jobs,
        null,
        "project-import",
        idempotencyKey,
      );
      return job ? { id: job.id, status: job.status } : null;
    },
    enqueue: async (input) => {
      const jobInput = {
        source: input.source,
        sourceIdentity: input.sourceIdentity,
        workspaceRoot: input.workspaceRoot,
        ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
      };
      const enqueued = await foundation.infrastructure.jobs.enqueue({
        id: foundation.infrastructure.ids.newId("job") as JobId,
        projectId: null,
        type: "project-import",
        input: jobInput,
        inputHash: hashContent(canonicalizeJson(jobInput)),
        idempotencyKey: input.idempotencyKey,
      });
      if ("conflict" in enqueued) return { ok: false, error: {
        code: ErrorCode.IdempotencyKeyReused,
        message: "project import idempotency key was reused with different input",
      } };
      return { ok: true, value: { id: enqueued.job.id } };
    },
  });
  let runtimeValue: NextHostedRuntime | null = null;
  const activateSelection = async (requested: string, sessionId?: string) => {
    const selected = sessionId
      ? await browser.resolveSelection({ sessionId, token: requested })
      : null;
    if (!selected?.ok) {
      return { ok: false as const, error: {
        code: ErrorCode.BrowseTokenInvalid,
        message: "workspace selection token is not valid",
      } };
    }
    const current = hostState.activeRuntime ?? runtimeValue;
    if (!current) {
      return { ok: false as const, error: {
        code: ErrorCode.WorkspaceUnavailable,
        message: "the daemon has no runtime to replace",
      } };
    }
    if (path.resolve(selected.value) === path.resolve(current.workspaceRoot)) {
      return { ok: true as const, value: { workspaceRoot: current.workspaceRoot, reauthRequired: true as const } };
    }
    if (hostState.switching) {
      return { ok: false as const, error: {
        code: ErrorCode.WorkspaceSwitching,
        message: "a workspace switch is already in progress",
      } };
    }
    if (await current.foundation.infrastructure.jobs.hasNonTerminalJob?.() === true) {
      return { ok: false as const, error: {
        code: ErrorCode.WorkspaceBusy,
        message: "a running job blocks workspace activation",
      } };
    }

    hostState.switching = true;
    let replacement: NextHostedRuntime | null = null;
    let discoveryAttempted = false;
    let committed = false;
    try {
      replacement = await startNextHostedRuntime(port, selected.value, {
        autoStarted: options.autoStarted,
        hostState,
        ...(hostState.host === undefined ? {} : { host: hostState.host }),
        ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
      });
      new AppSettingsStore(replacement.foundation.infrastructure.database).set(
        "active_workspace",
        replacement.workspaceRoot,
      );
      discoveryAttempted = true;
      await hostState.host?.replaceDiscovery(
        { workspaceRoot: current.workspaceRoot, instanceId },
        { workspaceRoot: replacement.workspaceRoot, instanceId },
      );
      activateHostedRuntime(port, replacement);
      committed = true;
      // Only after persistence, discovery and request routing all name the new
      // foundation. Until this point the old one stays authoritative and can be
      // restored without rebuilding it if any preparation step fails.
      try {
        hostState.terminals?.closeAll();
      } catch (error) {
        current.foundation.infrastructure.logger.error("previous workspace terminals cleanup failed", {
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
      await current.foundation.stop().catch((error) => {
        current.foundation.infrastructure.logger.error("previous workspace foundation cleanup failed", {
          error: error instanceof Error ? error.message : "unknown error",
        });
      });
      return { ok: true as const, value: {
        workspaceRoot: replacement.workspaceRoot,
        reauthRequired: true as const,
      } };
    } catch (cause) {
      const rollbackErrors: unknown[] = [];
      if (!committed && replacement) {
        // `replaceDiscovery` can fail after removing the old record. Reverse it
        // whenever it was attempted, not only when it reported success.
        if (discoveryAttempted && hostState.host) {
          try {
            await hostState.host.replaceDiscovery(
              { workspaceRoot: replacement.workspaceRoot, instanceId },
              { workspaceRoot: current.workspaceRoot, instanceId },
            );
          } catch (error) { rollbackErrors.push(error); }
        }
        try {
          new AppSettingsStore(current.foundation.infrastructure.database).set(
            "active_workspace",
            current.workspaceRoot,
          );
        } catch (error) { rollbackErrors.push(error); }
        try { await replacement.foundation.stop(); }
        catch (error) { rollbackErrors.push(error); }
      }
      const failure = rollbackErrors.length === 0
        ? cause
        : new AggregateError([cause, ...rollbackErrors], "workspace switch and rollback failed");
      return { ok: false as const, error: {
        code: ErrorCode.WorkspaceUnavailable,
        message: failure instanceof Error ? failure.message : String(failure),
      } };
    } finally {
      hostState.switching = false;
    }
  };
  const activeApp = createServerApp({
      port,
      uiOrigins: origins,
      nonces,
      sessions,
      mcpCredentials: foundation.infrastructure.credentials,
      mcp,
      bridge: {
        instanceId,
        workspaceRoot,
        daemonVersion: VIDCOM_VERSION,
        protocolVersions: [...SUPPORTED_REVISIONS],
        attachments,
        bridgeCredentialId: () => Promise.resolve(
          new AppSettingsStore(foundation.infrastructure.database).get(BRIDGE_CREDENTIAL_SETTING),
        ),
        leaseHeld: () => leaseHeld,
        invokeTool: async (request) => {
          try {
            const result = await registry.invoke(request.name, request.input, {
              era: request.era,
              protocolVersion: request.protocolVersion,
              credentialId: request.credentialId,
              // HTTP cannot elicit by itself. Carry the request as a stable
              // approval-required error; the stdio bridge turns it back into the
              // SDK's InputRequiredSignal and resumes with the returned grant.
              requestInput: async (input): Promise<never> => {
                throw new InputRequiredSignal(input);
              },
            });
            return result.ok
              ? { ok: true as const, value: result.value }
              : { ok: false as const, error: result.error };
          } catch (error) {
            if (!(error instanceof InputRequiredSignal)) throw error;
            return {
              ok: false as const,
              error: {
                code: ErrorCode.ApprovalRequired,
                message: error.request.message,
                details: { inputRequest: error.request },
              },
            };
          }
        },
      },
      projectReads,
      projectWrites,
      narration: {
        workspace: foundation.infrastructure.workspace,
        reads: foundation.application.readDependencies,
        jobs: foundation.infrastructure.jobs,
        tts: foundation.infrastructure.tts,
        ids: foundation.infrastructure.ids,
        hashContent,
      },
      jobs: foundation.infrastructure.jobs,
      events: foundation.infrastructure.events,
      history: foundation.infrastructure.mutationObserver,
      system: {
        browser,
        sessionId: (request) => browserSessionId(sessions, request),
        workspace: () => Promise.resolve({ workspaceRoot }),
        runtime: () => Promise.resolve({ platform: `${process.platform}-${process.arch}` }),
      },
      deliveryLoop: {
        workspaceRoot,
        workspaceOverview,
        activateWorkspace: activateSelection,
        browseSessionId: (request) => browserSessionId(sessions, request),
        lifecycle: foundation.application.lifecycle,
        diagnostics: foundation.application.diagnostics,
        agentKit: foundation.application.agentKit,
        writes: foundation.application.writeDependencies,
        reads: foundation.application.readDependencies,
        jobs: foundation.infrastructure.jobs,
        startProjectImport,
        enqueueRender: (input) => enqueueRenderJob(enqueueDependencies, input),
        enqueueSnapshot: (input) => enqueueSnapshotJob(enqueueDependencies, input),
        replaceRecoveryIdentity: (input) => foundation.application.lifecycle.replaceIdentity({
          entryId: input.entryId,
          identity: input.identity as unknown as ProjectIdentity,
          expectedContentHash: input.expectedContentHash,
          actor: "user",
        }),
        mimeFromPath: foundation.infrastructure.mimeFromPath,
      },
      agentTerminal: {
        workspace: foundation.infrastructure.workspace,
        terminals,
        mcpServer: agentMcp,
        workspaceRoot,
        agentKit: foundation.application.agentKit,
      },
    });
  const bootstrapApp = createServerApp({
    port,
    uiOrigins: origins,
    nonces,
    sessions,
    system: {
      browser,
      sessionId: (request) => browserSessionId(sessions, request),
      workspace: () => Promise.resolve({ workspaceRoot: null }),
      runtime: () => Promise.resolve({ platform: `${process.platform}-${process.arch}` }),
    },
    workspaceActivation: activateSelection,
  });
  runtimeValue = {
    foundation,
    nonces,
    instanceId,
    workspaceRoot,
    attachments,
    hostState,
    app: activeApp,
  };
  leaseLossHandler = async (lost) => {
    if (hostState.activeRuntime !== null && hostState.activeRuntime !== runtimeValue) return;
    const record = { workspaceRoot, instanceId };
    const outcome = await handleLeaseLoss(instanceId, {
      refuseWrites() {
        leaseHeld = false;
        setHostedApp(port, bootstrapApp);
      },
      removeDiscoveryRecord: () => hostState.host?.removeDiscovery(record) ?? Promise.resolve(),
      emitLeaseLost: () => lost.infrastructure.events.append({
        type: "workspace.lease_lost",
        projectId: null,
        payload: { workspaceRoot },
      }).then(() => undefined),
      reacquire: () => lost.leaseId === null
        ? Promise.resolve(false)
        : lost.infrastructure.lease.renew(lost.leaseId),
      hasAttachedUi: () => sessions.hasActiveSessions(),
      async toNoWorkspace() {
        await foundation.stop();
        if (hostState.activeRuntime === runtimeValue) hostState.activeRuntime = null;
      },
      async exitHeadless() {
        await foundation.stop();
        if (hostState.activeRuntime === runtimeValue) hostState.activeRuntime = null;
        await hostState.host?.exitHeadless(new Error("workspace lease was lost"));
      },
    });
    if (outcome.kind !== "recovered") return;

    await foundation.stop();
    try {
      const replacement = await startNextHostedRuntime(port, workspaceRoot, {
        autoStarted: options.autoStarted,
        hostState,
        ...(hostState.host === undefined ? {} : { host: hostState.host }),
        ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
      });
      await hostState.host?.replaceDiscovery(null, record);
      activateHostedRuntime(port, replacement);
    } catch (cause) {
      if (!sessions.hasActiveSessions()) {
        await hostState.host?.exitHeadless(new Error(
          `workspace lease recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ));
      }
    }
  };
  return runtimeValue;
}

/**
 * Registers a runtime under the port it serves.
 *
 * `handleNextHostedRequest` looks a runtime up by the port in the Host header,
 * so a daemon that built its own runtime without registering it would answer
 * its own requests while that lookup started a second one beside it.
 */
export function registerHostedRuntime(port: number, runtime: Promise<NextHostedRuntime>): void {
  runtimeMap().set(port, runtime);
  appMap().set(port, runtime.then((value) => {
    if (runtimeMap().get(port) === runtime) value.hostState.activeRuntime = value;
    return value.app;
  }));
}

export function getNextHostedRuntime(port: number): Promise<NextHostedRuntime> {
  const runtimes = runtimeMap();
  const pending = runtimes.get(port) ?? startNextHostedRuntime(port);
  if (!runtimes.has(port)) registerHostedRuntime(port, pending);
  pending.catch(() => {
    if (runtimes.get(port) === pending) {
      runtimes.delete(port);
      appMap().delete(port);
    }
  });
  return pending;
}

/** Next catch-all host: invalid Host requests still pass through the shared perimeter mapper. */
export async function handleNextHostedRequest(request: Request): Promise<Response> {
  const match = request.headers.get("Host")?.match(/^(?:127\.0\.0\.1|localhost):(\d{1,5})$/);
  const port = match ? Number(match[1]) : 0;
  if (!match || port < 1 || port > 65_535) {
    const clock = createSystemClock();
    return createServerApp({
      port: 0,
      uiOrigins: [],
      nonces: new InMemoryNonceStore(clock),
      sessions: new InMemorySessionStore(clock),
    }).fetch(request);
  }
  const target = appMap().get(port) ?? getNextHostedRuntime(port).then((runtime) => runtime.app);
  return (await target).fetch(request);
}
