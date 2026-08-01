import path from "node:path";
import os from "node:os";

import {
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  type ServerAppDependencies,
} from "@vidcom/server";
import { nodeSchedulerTimers } from "@vidcom/adapter";
import type { AbsolutePath } from "@vidcom/core";
import { JobScheduler } from "@vidcom/core";
import { createNoopProbeJobType } from "@vidcom/worker";

import { createSystemClock } from "./composition-root";
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

export function defaultAppDataRoot(): string {
  if (process.env.VIDCOM_APP_DATA) return path.resolve(process.env.VIDCOM_APP_DATA);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "VidCom");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), "VidCom");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "vidcom");
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
  const appDataRoot = defaultAppDataRoot();
  const workspaceRoot = await selectWorkspace({
    explicit: process.env.VIDCOM_WORKSPACE,
    appDataRoot,
  });
  let scheduler: JobScheduler | null = null;
  const foundation = await startVidcomFoundation({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    holderId: `next:${process.pid}:${crypto.randomUUID()}`,
    clock,
  }, {
    async recoverJobs({ infrastructure }) {
      scheduler = new JobScheduler(
        infrastructure.jobs,
        infrastructure.clock,
        infrastructure.ids,
        [createNoopProbeJobType()],
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
  return {
    foundation,
    nonces,
    app: createServerApp({
      port,
      uiOrigins: origins,
      nonces,
      sessions,
      projectReads,
      projectWrites,
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
