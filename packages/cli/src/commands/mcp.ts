import { randomUUID } from "node:crypto";

import { nodeSchedulerTimers } from "@vidcom/adapter";
import { SUPPORTED_REVISIONS } from "@vidcom/contracts";
import { JobScheduler, type AbsolutePath } from "@vidcom/core";
import { startMcpStdio } from "@vidcom/mcp";
import { createNoopProbeJobType } from "@vidcom/worker";

import { CliInputError } from "../cli-error";
import { createMcpRegistry } from "../composition-root";
import { defaultAppDataRoot } from "../next-host";
import { startVidcomFoundation } from "../startup";
import { selectWorkspace } from "../workspace-selection";

export interface McpCommandOptions {
  workspace?: string;
  protocol?: string;
}

export interface McpCommandDependencies {
  appDataRoot(): string;
  selectWorkspace: typeof selectWorkspace;
  startStdio: typeof startMcpStdio;
  writeError(message: string): void;
}

export interface ShutdownSignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

const defaultDependencies: McpCommandDependencies = {
  appDataRoot: defaultAppDataRoot,
  selectWorkspace,
  startStdio: startMcpStdio,
  writeError: (message) => process.stderr.write(`${message}\n`),
};

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

/** Starts the full workspace foundation and exposes MCP over stdio without HTTP credential auth. */
export async function startVidcomMcp(
  options: McpCommandOptions,
  dependencies: McpCommandDependencies = defaultDependencies,
) {
  const appDataRoot = dependencies.appDataRoot();
  const workspaceRoot = await dependencies.selectWorkspace({
    explicit: options.workspace ?? process.env.VIDCOM_WORKSPACE,
    appDataRoot,
  });
  let scheduler: JobScheduler | null = null;
  return startVidcomFoundation({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    holderId: `mcp:${process.pid}:${randomUUID()}`,
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
    async openListener({ infrastructure, application }) {
      if (!application) throw new Error("MCP application was not initialized");
      const registry = createMcpRegistry(infrastructure, application);
      return dependencies.startStdio(registry, {
        onerror: (error) => dependencies.writeError(error.message),
      }, options.protocol ? { pinnedRevision: options.protocol } : {});
    },
  });
}

/** Waits for one termination signal and closes every foundation resource exactly once. */
export function waitForMcpShutdown(
  runtime: { stop(): Promise<void> },
  signals: ShutdownSignalSource = process,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      signals.removeListener("SIGINT", shutdown);
      signals.removeListener("SIGTERM", shutdown);
      void runtime.stop().then(resolve, reject);
    };
    signals.once("SIGINT", shutdown);
    signals.once("SIGTERM", shutdown);
  });
}

/** Starts stdio and retains the process until SIGINT/SIGTERM completes ordered cleanup. */
export async function runMcpCommand(argv: readonly string[]): Promise<void> {
  const runtime = await startVidcomMcp(parseMcpCommandArgs(argv));
  await waitForMcpShutdown(runtime);
}
