import path from "node:path";
import os from "node:os";

import {
  AttachmentRegistry,
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  type ServerAppDependencies,
} from "@vidcom/server";
import { AppSettingsStore, ensureVidcomSettingsFile, nodeSchedulerTimers, readVidcomSettings } from "@vidcom/adapter";
import type { ResolvedVidcomSettings } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";
import { JobScheduler, type ProjectIdentity } from "@vidcom/core";
import { createMcpHttpHandlers } from "@vidcom/mcp";
import { enqueueRenderJob, enqueueSnapshotJob } from "@vidcom/worker";

import { createJobTypes, createMcpRegistry, createSystemClock, hashContent } from "./composition-root";
import { startVidcomFoundation } from "./startup";
import { BrowseTokenStore } from "@vidcom/core";
import { ErrorCode, SUPPORTED_REVISIONS } from "@vidcom/contracts";
import { BRIDGE_CREDENTIAL_SETTING } from "./bridge-credential";
import { VIDCOM_VERSION } from "./commands/version";
import { runtimePathsFor } from "./runtime-paths-source";
import { selectWorkspace } from "./workspace-selection";

export interface NextHostedRuntime {
  app: ReturnType<typeof createServerApp>;
  foundation: Awaited<ReturnType<typeof startVidcomFoundation<null>>>;
  nonces: InMemoryNonceStore;
  /** Identifies this process for the lifetime of one start, for discovery and handshake. */
  instanceId: string;
  workspaceRoot: string;
  attachments: AttachmentRegistry;
}

interface RuntimeGlobal {
  __vidcomNextRuntimes?: Map<number, Promise<NextHostedRuntime>>;
}

/**
 * Where the database, model cache and backups live.
 *
 * `VIDCOM_APP_DATA` wins, then `appDataRoot` from `~/.vidcom/setting.json`, then
 * the platform convention. Settings come last of the three so an operator can
 * redirect one run without editing a file, and so an existing install keeps its
 * database when a settings file appears.
 */
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

export function defaultAppDataRoot(settings?: ResolvedVidcomSettings): string {
  if (process.env.VIDCOM_APP_DATA) return path.resolve(process.env.VIDCOM_APP_DATA);
  if (settings?.appDataRoot) return path.resolve(settings.appDataRoot);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "VidCom");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), "VidCom");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "vidcom");
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

export async function startNextHostedRuntime(
  port: number,
  explicitWorkspace?: string,
  options: { autoStarted?: boolean } = {},
): Promise<NextHostedRuntime> {
  const clock = createSystemClock();
  const nonces = new InMemoryNonceStore(clock);
  const bootstrapNonce = process.env.VIDCOM_BOOTSTRAP_NONCE;
  delete process.env.VIDCOM_BOOTSTRAP_NONCE;
  if (bootstrapNonce) nonces.register(bootstrapNonce);
  const sessions = new InMemorySessionStore(clock);
  // New on every start, deliberately. A restarted daemon that reused its id
  // would satisfy a handshake meant for the process that died, and every check
  // after that would pass.
  const instanceId = `daemon_${crypto.randomUUID()}`;
  let leaseHeld = true;
  // Settings first: the file is allowed to say where application data lives, so
  // nothing that depends on that path can be computed before it is read.
  const settings = await readVidcomSettings();
  const appDataRoot = defaultAppDataRoot(settings);
  await ensureVidcomSettingsFile();
  const workspaceRoot = await selectWorkspace({
    explicit: explicitWorkspace ?? process.env.VIDCOM_WORKSPACE ?? settings.workspaceRoot,
    appDataRoot,
  });
  let scheduler: JobScheduler | null = null;
  const foundation = await startVidcomFoundation({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    nativeDependenciesRoot: defaultNativeDependenciesRoot(appDataRoot) as AbsolutePath,
    // Complete or not at all. A half-filled set produces paths that look valid
    // and point at nothing, which fails much later and somewhere else.
    runtimePaths: runtimePathsFor(appDataRoot),
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
    onLeaseLost() {
      leaseHeld = false;
      sessions.revokeAll();
    },
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
  };
  const registry = createMcpRegistry(foundation.infrastructure, foundation.application);
  const mcp = createMcpHttpHandlers(registry);
  const attachments = new AttachmentRegistry({
    clock,
    instanceId,
    // Only a daemon a client started on demand may retire itself. One a person
    // started stays up until that person stops it, however quiet it gets.
    autoStarted: options.autoStarted ?? false,
    hasActiveWork: () => foundation.infrastructure.jobs.hasNonTerminalJob?.() ?? false,
  });
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
  };
  return {
    foundation,
    nonces,
    instanceId,
    workspaceRoot,
    attachments,
    app: createServerApp({
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
        // The daemon's own registry runs the tool, so the audit entry is written
        // here. A bridge that dies mid-call cannot take the record with it.
        invokeTool: async (request) => {
          const result = await registry.invoke(request.name, request.input, {
            era: "modern",
            protocolVersion: request.protocolVersion,
            credentialId: request.credentialId,
            requestInput: () => Promise.reject(
              new Error("the bridge cannot elicit input from a person"),
            ),
          });
          return result.ok
            ? { ok: true as const, value: result.value }
            : { ok: false as const, error: result.error };
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
      deliveryLoop: {
        workspaceRoot,
        workspaceOverview,
        // `requested` is a browse selection token, not a path. Resolving it is
        // the only way an absolute path enters here, and the token was minted
        // for this session against a directory the user walked to.
        activateWorkspace: async (requested) => {
          const held = hostBrowseTokens.peek(requested, HOST_BROWSE_SESSION);
          if (!held) {
            return { ok: false as const, error: {
              code: ErrorCode.BrowseTokenInvalid,
              message: "workspace selection token is not valid",
            } };
          }
          const selected = await selectWorkspace({ explicit: held.canonicalPath, appDataRoot });
          foundation.infrastructure.entries.clear();
          await foundation.infrastructure.events.append({
            type: "workspace.changed",
            projectId: null,
            payload: { operation: "activate", workspaceRoot: selected },
          });
          if (path.resolve(selected) !== path.resolve(workspaceRoot)) {
            const replacement = startNextHostedRuntime(port, selected);
            runtimeMap().set(port, replacement);
            await replacement;
            setTimeout(() => void foundation.stop(), 0);
          }
          return { ok: true, value: { workspaceRoot: selected, reauthRequired: true as const } };
        },
        lifecycle: foundation.application.lifecycle,
        diagnostics: foundation.application.diagnostics,
        agentKit: foundation.application.agentKit,
        writes: foundation.application.writeDependencies,
        reads: foundation.application.readDependencies,
        jobs: foundation.infrastructure.jobs,
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
    }),
  };
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
}

export function getNextHostedRuntime(port: number): Promise<NextHostedRuntime> {
  const runtimes = runtimeMap();
  const pending = runtimes.get(port) ?? startNextHostedRuntime(port);
  runtimes.set(port, pending);
  pending.catch(() => {
    if (runtimes.get(port) === pending) runtimes.delete(port);
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
  return (await getNextHostedRuntime(port)).app.fetch(request);
}
