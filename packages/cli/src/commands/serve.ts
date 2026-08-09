import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { DaemonDiscoveryStore, workspaceHash } from "@vidcom/adapter";
import { bindLoopback, type LoopbackListener } from "@vidcom/server";

import { CliInputError } from "../cli-error";
import { defaultAppDataRoot, registerHostedRuntime, startNextHostedRuntime } from "../next-host";
import { createRequestRouter, type FetchTarget } from "../loopback-host";
import {
  MANIFEST_ASSET,
  PACK_ASSET,
  createSeaStaticAssetHost,
  type SeaAssetSource,
} from "../sea-static-host";

export interface ServeCommandOptions {
  workspace?: string;
  port?: number;
  /** Started on demand by a client, and therefore allowed to retire itself. */
  ensure?: boolean;
}

export function parseServeCommandArgs(argv: readonly string[]): ServeCommandOptions {
  const options: ServeCommandOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--ensure") {
      if (options.ensure) throw new CliInputError("--ensure may be provided only once");
      options.ensure = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag !== "--workspace" && flag !== "--port") {
      throw new CliInputError(`unknown serve argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) throw new CliInputError(`${flag} requires a value`);
    if (flag === "--workspace") {
      if (options.workspace !== undefined) throw new CliInputError("--workspace may be provided only once");
      options.workspace = value;
    } else {
      if (options.port !== undefined) throw new CliInputError("--port may be provided only once");
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new CliInputError("--port must be an integer between 1 and 65535");
      }
      options.port = port;
    }
    index += 1;
  }
  return options;
}

export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        return reject(new Error("could not allocate loopback port"));
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

/**
 * Finds the embedded frontend, wherever this build keeps it.
 *
 * A packaged executable reads it out of itself. A source checkout that has run
 * `build:artifact` has the same two files on disk, and serving those is what
 * makes the packaged UI testable without packaging. A checkout that has built
 * neither gets `null`, and the daemon says so instead of serving an empty page.
 */
export function resolveStaticAssets(distDirectory: string): SeaAssetSource | null {
  const sea = (globalThis as { process?: { versions?: Record<string, string> } })
    .process?.versions?.["sea"];
  if (sea !== undefined) {
    // Required lazily: `node:sea` does not exist outside a packaged build, and
    // importing it at module scope would break every other mode.
    const runtime = (globalThis as { require?: (id: string) => { getRawAsset(key: string): ArrayBuffer } })
      .require?.("node:sea");
    if (runtime) return { getRawAsset: (key) => runtime.getRawAsset(key) };
  }
  try {
    const files = new Map([
      [MANIFEST_ASSET, readFileSync(path.join(distDirectory, MANIFEST_ASSET))],
      [PACK_ASSET, readFileSync(path.join(distDirectory, PACK_ASSET))],
    ]);
    return {
      getRawAsset(key: string): ArrayBuffer {
        const bytes = files.get(key);
        if (!bytes) throw new Error(`no embedded asset named ${key}`);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    };
  } catch {
    return null;
  }
}

/** Says what is missing, because an empty page looks like a broken app. */
export function unbuiltFrontendTarget(): FetchTarget {
  return () => new Response(
    "The frontend has not been built into this checkout. Run `bun run build:artifact`,"
    + " or use `next dev` against this daemon.\n",
    { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export interface ServingDaemon {
  listener: LoopbackListener;
  instanceId: string;
  workspaceRoot: string;
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Runs the daemon: one listener, one workspace, one discovery record.
 *
 * The record is published only once everything behind it answers, and removed
 * before the lease is released. A record that appears early points clients at a
 * daemon that will refuse them; one that lingers points them at nothing.
 */
export async function startServing(options: ServeCommandOptions = {}): Promise<ServingDaemon> {
  const appDataRoot = defaultAppDataRoot();
  const port = options.port ?? await freeLoopbackPort();
  const pending = startNextHostedRuntime(port, options.workspace ?? process.env.VIDCOM_WORKSPACE);
  registerHostedRuntime(port, pending);
  const runtime = await pending;

  const assets = resolveStaticAssets(path.join(process.cwd(), "dist", "sea"));
  const staticTarget: FetchTarget = assets === null
    ? unbuiltFrontendTarget()
    : (request) => createSeaStaticAssetHost(assets).handle(request);
  const router = createRequestRouter({
    api: (request) => runtime.app.fetch(request),
    static: staticTarget,
  });

  const listener = await bindLoopback({ fetch: (request) => router.handle(request) }, port);
  const discovery = new DaemonDiscoveryStore(appDataRoot);
  await discovery.publish({
    schemaVersion: 1,
    workspaceRoot: runtime.workspaceRoot,
    workspaceHash: workspaceHash(runtime.workspaceRoot),
    instanceId: runtime.instanceId,
    pid: process.pid,
    host: "127.0.0.1",
    port: listener.port,
    startedAt: new Date().toISOString(),
  });

  let stopped: Promise<void> | null = null;
  return {
    listener,
    instanceId: runtime.instanceId,
    workspaceRoot: runtime.workspaceRoot,
    baseUrl: `http://127.0.0.1:${listener.port}`,
    stop() {
      // One teardown, however many callers: a signal handler and an error path
      // both reach here, and running it twice releases a lease this process no
      // longer holds.
      return stopped ??= (async () => {
        await discovery.remove(runtime.workspaceRoot, runtime.instanceId);
        await listener.close();
        await runtime.foundation.stop();
      })();
    },
  };
}

export interface ServeCommandIo {
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export async function runServeCommand(
  argv: readonly string[],
  io: ServeCommandIo = { stderr: process.stderr },
): Promise<void> {
  const daemon = await startServing(parseServeCommandArgs(argv));
  // The address goes to stderr. stdout belongs to whatever a caller pipes this
  // into, and a daemon that prints its banner there breaks the first such use.
  io.stderr.write(`VidCom is serving ${daemon.workspaceRoot} at ${daemon.baseUrl}\n`);
  await waitForShutdown(daemon);
}

export function waitForShutdown(daemon: ServingDaemon): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      daemon.stop().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
