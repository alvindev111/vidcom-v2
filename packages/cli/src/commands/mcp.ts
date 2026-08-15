import { realpath } from "node:fs/promises";

import {
  BridgeCredentialStore,
  DaemonDiscoveryStore,
  createDaemonClient,
  openVidcomDatabase,
  readVidcomSettings,
  type DaemonClient,
  type VidcomDatabase,
} from "@vidcom/adapter";
import { SUPPORTED_REVISIONS, type ResolvedVidcomSettings } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";
import {
  registerVidcomTools,
  startMcpStdio,
  ToolRegistry,
  type ToolRegistryDependencies,
  type VidcomToolDependencies,
} from "@vidcom/mcp";

import { ensureDaemon } from "../bridge/ensure-daemon";
import { createRemoteToolInvoker } from "../bridge/remote-tool-invoker";
import { spawnEnsuredDaemon, waitForDaemonRecord } from "../bridge/spawn-daemon";
import { CliInputError } from "../cli-error";
import { defaultAppDataRoot } from "../next-host";
import { selectWorkspace } from "../workspace-selection";
import { VIDCOM_VERSION } from "./version";

export interface McpCommandOptions {
  workspace?: string;
  protocol?: string;
}

export interface McpCommandDependencies {
  appDataRoot(settings?: ResolvedVidcomSettings): string;
  /**
   * Reads `~/.vidcom/setting.json`. Unlike the app entry point this does NOT
   * create a template: `vidcom mcp` is spawned by an AI host, and writing to the
   * user's home as a side effect of a tool handshake is not this command's call.
   */
  readSettings(): Promise<ResolvedVidcomSettings>;
  selectWorkspace: typeof selectWorkspace;
  canonicalizeWorkspace(workspaceRoot: string): Promise<string>;
  openWorkspaceDatabase(appDataRoot: string): VidcomDatabase;
  connectBridge(input: { appDataRoot: string; workspaceRoot: string }): Promise<McpBridgeConnection>;
  startStdio: typeof startMcpStdio;
  writeError(message: string): void;
}

export interface McpBridgeConnection {
  client: DaemonClient;
  attachmentId: string;
  heartbeatEveryMs: number;
}

export interface ShutdownSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

interface McpShutdownRuntime {
  stop(): Promise<void>;
  listener?: { closed?: Promise<void> };
}

const defaultDependencies: McpCommandDependencies = {
  appDataRoot: defaultAppDataRoot,
  readSettings: () => readVidcomSettings(),
  selectWorkspace,
  canonicalizeWorkspace: realpath,
  openWorkspaceDatabase: openVidcomDatabase,
  connectBridge: connectMcpBridge,
  startStdio: startMcpStdio,
  writeError: (message) => process.stderr.write(`${message}\n`),
};

function remoteOnlyDependencies(): ToolRegistryDependencies & VidcomToolDependencies {
  return new Proxy({}, {
    get() {
      throw new Error("the stdio bridge catalogue cannot execute tools locally");
    },
  }) as ToolRegistryDependencies & VidcomToolDependencies;
}

/** Builds the public catalogue without constructing a second application/foundation. */
function createBridgeCatalogue(): ToolRegistry {
  const dependencies = remoteOnlyDependencies();
  const registry = new ToolRegistry(dependencies);
  registerVidcomTools(registry, dependencies);
  return registry;
}

function sourceLauncherPrefix(): readonly string[] {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea(): boolean } | undefined;
  if (sea?.isSea() === true) return [];
  const launcher = process.argv[1];
  return launcher ? [launcher] : [];
}

/** Finds or starts the one daemon that owns the workspace, then attaches as stdio bridge. */
async function connectMcpBridge(input: {
  appDataRoot: string;
  workspaceRoot: string;
}): Promise<McpBridgeConnection> {
  const discovery = new DaemonDiscoveryStore(input.appDataRoot);
  const bearer = await new BridgeCredentialStore(input.appDataRoot).read().catch(() => null);
  if (bearer === null) {
    throw new CliInputError(
      "this machine has no system bridge credential yet; start the app once, or run `vidcom serve`",
    );
  }
  const connect = (record: { port: number }): DaemonClient => createDaemonClient({
    baseUrl: `http://127.0.0.1:${record.port}`,
    bearer,
  });
  const ensured = await ensureDaemon({
    workspaceRoot: input.workspaceRoot,
    kind: "bridge",
    clientVersion: VIDCOM_VERSION,
    readRecord: (root) => discovery.read(root),
    connect,
    spawnDaemon: (root) => {
      spawnEnsuredDaemon({ workspaceRoot: root, prefixArgs: sourceLauncherPrefix() });
      return Promise.resolve();
    },
    waitForRecord: (root, rejectedInstanceId) => waitForDaemonRecord(
      () => discovery.read(root),
      {
        accept: rejectedInstanceId === undefined
          ? undefined
          : (record) => record.instanceId !== rejectedInstanceId,
      },
    ),
  });
  return {
    client: connect(ensured.record),
    attachmentId: ensured.attachmentId,
    heartbeatEveryMs: ensured.heartbeatEveryMs,
  };
}

/** Parses the complete stdio option set and rejects unsupported protocol pins before startup. */
export function parseMcpCommandArgs(argv: readonly string[]): McpCommandOptions {
  const options: McpCommandOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--workspace" && flag !== "--protocol") {
      throw new CliInputError(`unknown mcp argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) throw new CliInputError(`${flag} requires a value`);
    if (flag === "--workspace") {
      if (options.workspace !== undefined) throw new CliInputError("--workspace may be provided only once");
      options.workspace = value;
    } else {
      if (options.protocol !== undefined) throw new CliInputError("--protocol may be provided only once");
      if (!SUPPORTED_REVISIONS.includes(value as typeof SUPPORTED_REVISIONS[number])) {
        throw new CliInputError(`unsupported protocol revision ${value}; supported: ${SUPPORTED_REVISIONS.join(", ")}`);
      }
      options.protocol = value;
    }
    index += 1;
  }
  return options;
}

/**
 * Starts a protocol-only stdio facade over the daemon that owns this workspace.
 *
 * The bridge never acquires the workspace lease and never constructs workers,
 * watchers, or application services. Those remain daemon-owned so UI and agent
 * sessions share one writer and queued work outlives the stdio child.
 */
export async function startVidcomMcp(
  options: McpCommandOptions,
  dependencies: McpCommandDependencies = defaultDependencies,
  signal?: AbortSignal,
) {
  // Settings first: the file is allowed to say where application data lives, so
  // nothing that depends on that path can be computed before it is read.
  const settings = await dependencies.readSettings();
  const appDataRoot = dependencies.appDataRoot(settings);
  const configuredWorkspace = options.workspace
    ?? process.env.VIDCOM_WORKSPACE
    ?? settings.workspaceRoot;
  let workspaceRoot: AbsolutePath;
  if (configuredWorkspace) {
    // An explicit/configured workspace is already enough to address discovery.
    // Do not extract runtime assets or migrate the daemon's database merely to
    // attach to a healthy daemon that owns both of those responsibilities.
    try {
      workspaceRoot = await dependencies.canonicalizeWorkspace(configuredWorkspace) as AbsolutePath;
    } catch {
      throw new CliInputError(`explicit workspace is not readable: ${configuredWorkspace}`);
    }
  } else {
    // The saved active-workspace fallback lives in SQLite. Open the daemon's
    // existing state directly without migration or runtime extraction; this is
    // a short-lived settings read and never acquires a workspace lease.
    const database = dependencies.openWorkspaceDatabase(appDataRoot);
    try {
      const selected = await dependencies.selectWorkspace({
        appDataRoot,
        database,
      });
      workspaceRoot = await dependencies.canonicalizeWorkspace(selected) as AbsolutePath;
    } finally {
      await database.destroy();
    }
  }
  signal?.throwIfAborted();

  let connection = await dependencies.connectBridge({ appDataRoot, workspaceRoot });
  if (signal?.aborted) {
    await connection.client.detach(connection.attachmentId).catch(() => undefined);
    signal.throwIfAborted();
  }
  const registry = createBridgeCatalogue();
  const invoker = createRemoteToolInvoker(() => connection.client);
  let listener: Awaited<ReturnType<typeof startMcpStdio>>;
  try {
    listener = await dependencies.startStdio(registry, {
      onerror: (error) => dependencies.writeError(error.message),
    }, {
      ...(options.protocol ? { pinnedRevision: options.protocol } : {}),
      invoker,
    });
  } catch (error) {
    await connection.client.detach(connection.attachmentId).catch(() => undefined);
    throw error;
  }

  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let maintenance: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const scheduleHeartbeat = () => {
    if (stopped) return;
    heartbeatTimer = setTimeout(() => {
      maintenance = maintainAttachment().finally(() => {
        maintenance = null;
        scheduleHeartbeat();
      });
    }, connection.heartbeatEveryMs);
    heartbeatTimer.unref?.();
  };
  const maintainAttachment = async (): Promise<void> => {
    try {
      await connection.client.renew(connection.attachmentId);
      return;
    } catch {
      // A credential rotation or daemon restart invalidates both client and
      // attachment. Re-resolve both instead of retrying the possibly committed
      // tool request that happened to expose the failure.
    }
    try {
      const replacement = await dependencies.connectBridge({ appDataRoot, workspaceRoot });
      if (stopped) {
        await replacement.client.detach(replacement.attachmentId).catch(() => undefined);
        return;
      }
      const previous = connection;
      connection = replacement;
      await previous.client.detach(previous.attachmentId).catch(() => undefined);
    } catch {
      dependencies.writeError("daemon bridge heartbeat failed; waiting to reconnect");
    }
  };
  scheduleHeartbeat();

  return {
    listener,
    stop: () => stopPromise ??= (async () => {
      stopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      await listener.close();
      await maintenance?.catch(() => undefined);
      await connection.client.detach(connection.attachmentId).catch(() => undefined);
    })(),
  };
}

/** Installs the signal gate before startup and retains it until cleanup settles. */
export async function runMcpLifecycle(
  start: (signal: AbortSignal) => Promise<McpShutdownRuntime>,
  signals: ShutdownSignalSource = process,
): Promise<void> {
  const controller = new AbortController();
  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => { requestShutdown = resolve; });
  const shutdown = () => {
    if (!controller.signal.aborted) controller.abort();
    requestShutdown();
  };
  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);
  try {
    let runtime: McpShutdownRuntime;
    try { runtime = await start(controller.signal); }
    catch (error) {
      if (controller.signal.aborted && error === controller.signal.reason) return;
      throw error;
    }
    await Promise.race([
      shutdownRequested,
      runtime.listener?.closed ?? new Promise<void>(() => undefined),
    ]);
    await runtime.stop();
  } finally {
    signals.removeListener("SIGINT", shutdown);
    signals.removeListener("SIGTERM", shutdown);
  }
}

/** Waits for signal/disconnect and closes every foundation resource exactly once. */
export function waitForMcpShutdown(
  runtime: McpShutdownRuntime,
  signals: ShutdownSignalSource = process,
): Promise<void> {
  return runMcpLifecycle(async () => runtime, signals);
}

/** Retains stdio until a signal or host disconnect completes ordered cleanup. */
export async function runMcpCommand(argv: readonly string[]): Promise<void> {
  const options = parseMcpCommandArgs(argv);
  await runMcpLifecycle((signal) => startVidcomMcp(options, defaultDependencies, signal));
}
