import path from "node:path";
import os from "node:os";

import {
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  type ServerAppDependencies,
} from "@vidcom/server";
import { ensureVidcomSettingsFile, nodeSchedulerTimers, readVidcomSettings } from "@vidcom/adapter";
import type { ResolvedVidcomSettings } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";
import { JobScheduler } from "@vidcom/core";
import { createMcpHttpHandlers } from "@vidcom/mcp";

import { createJobTypes, createMcpRegistry, createSystemClock, hashContent } from "./composition-root";
import { startVidcomFoundation } from "./startup";
import { selectWorkspace } from "./workspace-selection";

interface NextHostedRuntime {
  app: ReturnType<typeof createServerApp>;
  foundation: Awaited<ReturnType<typeof startVidcomFoundation<null>>>;
  nonces: InMemoryNonceStore;
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

async function startNextHostedRuntime(port: number): Promise<NextHostedRuntime> {
  const clock = createSystemClock();
  const nonces = new InMemoryNonceStore(clock);
  const bootstrapNonce = process.env.VIDCOM_BOOTSTRAP_NONCE;
  delete process.env.VIDCOM_BOOTSTRAP_NONCE;
  if (bootstrapNonce) nonces.register(bootstrapNonce);
  const sessions = new InMemorySessionStore(clock);
  // Settings first: the file is allowed to say where application data lives, so
  // nothing that depends on that path can be computed before it is read.
  const settings = await readVidcomSettings();
  const appDataRoot = defaultAppDataRoot(settings);
  await ensureVidcomSettingsFile();
  const workspaceRoot = await selectWorkspace({
    explicit: process.env.VIDCOM_WORKSPACE ?? settings.workspaceRoot,
    appDataRoot,
  });
  let scheduler: JobScheduler | null = null;
  const foundation = await startVidcomFoundation({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    nativeDependenciesRoot: defaultNativeDependenciesRoot(appDataRoot) as AbsolutePath,
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
    onLeaseLost() { sessions.revokeAll(); },
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
  const mcp = createMcpHttpHandlers(createMcpRegistry(
    foundation.infrastructure,
    foundation.application,
  ));
  return {
    foundation,
    nonces,
    app: createServerApp({
      port,
      uiOrigins: origins,
      nonces,
      sessions,
      mcpCredentials: foundation.infrastructure.credentials,
      mcp,
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
    }),
  };
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
