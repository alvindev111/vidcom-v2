#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { defaultAppDataRoot } from "./next-host";
import { runMcpCommand } from "./commands/mcp";
import { runApproveCommand } from "./commands/approve";
import { runCredentialCommand } from "./commands/credential";
import { runBackupCommand } from "./commands/backup";
import { runRecoveryCommand } from "./commands/recovery";
import { parseDoctorCommandArgs, runDoctor } from "./commands/doctor";
import { createDoctorContext } from "./commands/doctor-context";
import { repairRuntime } from "./commands/doctor-repair";
import { runRenderCommand } from "./commands/render";
import { connectRenderClient, renderWorkspaceSource } from "./commands/render-connect";
import { runServeCommand, startServing, waitForShutdown } from "./commands/serve";
import { VIDCOM_VERSION, runVersionCommand } from "./commands/version";
import { DaemonDiscoveryStore } from "@vidcom/adapter";

import { isNodeSentinel, runNodeSentinel } from "./node-sentinel";
import { CliInputError } from "./cli-error";

export { CliInputError } from "./cli-error";

export type VidcomCommandName =
  | "app"
  | "serve"
  | "mcp"
  | "render"
  | "doctor"
  | "version"
  | "approve"
  | "credential"
  | "backup"
  | "recovery";

export interface ParsedVidcomCommand {
  name: VidcomCommandName;
  args: string[];
}

export interface AppCommandOptions {
  workspace?: string;
  port?: number;
}

/**
 * Every mode the executable answers to, in the order `--help` lists them.
 *
 * `worker` is deliberately absent (OQ-9): `packages/worker` stays exactly as it
 * is, run in-process, and publishing a mode for it would promise a supported
 * entry point that nothing else in the product uses.
 */
export const VIDCOM_COMMAND_NAMES: readonly VidcomCommandName[] = [
  "app", "serve", "mcp", "render", "doctor", "version",
  "approve", "credential", "backup", "recovery",
];

const COMMAND_NAMES = new Set<VidcomCommandName>(VIDCOM_COMMAND_NAMES);

/** Selects one strict top-level command; bare invocation and leading app options alias `vidcom app`. */
export function parseVidcomCommand(argv: readonly string[]): ParsedVidcomCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith("--")) return { name: "app", args: [...argv] };
  if (!COMMAND_NAMES.has(first as VidcomCommandName)) {
    // Listing them costs one line and saves the user a search. A bare "unknown
    // command" is the least useful thing a CLI can say when the answer is a
    // fixed, short set.
    throw new CliInputError(
      `unknown command: ${first}. Available: ${VIDCOM_COMMAND_NAMES.join(", ")}`,
    );
  }
  return { name: first as VidcomCommandName, args: rest };
}

/** Parses the complete app option set without accepting duplicates, unknown flags or positionals. */
export function parseAppCommandArgs(argv: readonly string[]): AppCommandOptions {
  const options: AppCommandOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--workspace" && flag !== "--port") {
      throw new CliInputError(`unknown app argument: ${flag}`);
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

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: "ignore" });
  opener.unref();
}

/** Creates a single-use bootstrap nonce with the 32-byte entropy required by the nonce store. */
export function createBootstrapNonce(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Serves the workspace and hands the browser an authenticated session.
 *
 * `app` is `serve` plus two things: it opens a browser, and it mints a
 * single-use bootstrap nonce for that browser to exchange. It used to spawn
 * `next start`; the frontend is a static export now, so there is no Next server
 * to spawn and the daemon serves the exported pack itself.
 */
export async function runVidcomApp(options: AppCommandOptions = {}): Promise<void> {
  const nonce = createBootstrapNonce();
  // Read by the host while it builds its nonce store, and deleted there. It is
  // an environment variable rather than an argument because the host is the
  // only reader and nothing should be able to pass it in from a command line.
  process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
  const daemon = await startServing(options);
  openBrowser(`${daemon.baseUrl}/?t=${encodeURIComponent(nonce)}`);
  process.stdout.write(`VidCom is running at ${daemon.baseUrl}\n`);
  await waitForShutdown(daemon);
}
/** Yields once per interrupt, so `render` can tell the first from the second. */
async function* interruptSignals(): AsyncGenerator<void> {
  const queue: Array<() => void> = [];
  let pending = 0;
  const onSignal = () => {
    const waiter = queue.shift();
    if (waiter) waiter();
    else pending += 1;
  };
  process.on("SIGINT", onSignal);
  try {
    for (;;) {
      if (pending > 0) {
        pending -= 1;
        yield;
        continue;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      yield;
    }
  } finally {
    process.off("SIGINT", onSignal);
  }
}

export async function runVidcomCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // Dispatched ahead of the public parser on purpose. `parseVidcomCommand`
  // reads any argv starting with `--` as `vidcom app`, so the sentinel would
  // otherwise start the whole application instead of running a script — and
  // silently, since that path raises nothing.
  if (isNodeSentinel(argv)) {
    await runNodeSentinel(argv, path.join(defaultAppDataRoot(), "native"));
    return;
  }
  const command = parseVidcomCommand(argv);
  if (command.name === "app") {
    await runVidcomApp(parseAppCommandArgs(command.args));
    return;
  }
  if (command.name === "doctor") {
    const options = parseDoctorCommandArgs(command.args);
    const context = await createDoctorContext({ deep: options.deep === true });
    process.exitCode = await runDoctor({
      context,
      options,
      repair: (failing) => repairRuntime(failing, {
        appDataRoot: context.appDataRoot,
        activeWorkspace: () => context.probes.activeWorkspace()
          .then((result) => result.detail ?? null),
        discovery: new DaemonDiscoveryStore(context.appDataRoot),
        reextract: () => Promise.reject(new CliInputError(
          "this build has no runtime archives to re-extract from",
        )),
      }),
      // The packaged smoke sets this, and there a skipped required component is
      // a failure rather than a "not yet".
      strict: process.env.VIDCOM_DOCTOR_STRICT === "1",
    });
    return;
  }
  if (command.name === "render") {
    const code = await runRenderCommand(command.args, {
      connect: () => connectRenderClient(command.args),
      workspaceSource: () => renderWorkspaceSource(command.args),
      interrupts: interruptSignals(),
    });
    // The render's own exit code is the contract, so it is set rather than
    // thrown: a non-zero render is a normal outcome, not a CLI input error.
    process.exitCode = code;
    return;
  }
  if (command.name === "serve") {
    await runServeCommand(command.args);
    return;
  }
  if (command.name === "version") {
    await runVersionCommand(command.args, {
      // The version is read from the package rather than injected at build
      // time, so a source checkout reports the same number it was built from.
      vidcom: VIDCOM_VERSION,
      buildCommit: process.env.VIDCOM_BUILD_COMMIT ?? null,
    });
    return;
  }
  if (command.name === "mcp") {
    await runMcpCommand(command.args);
    return;
  }
  if (command.name === "approve") {
    await runApproveCommand(command.args);
    return;
  }
  if (command.name === "credential") {
    await runCredentialCommand(command.args);
    return;
  }
  if (command.name === "backup") {
    await runBackupCommand(command.args);
    return;
  }
  if (command.name === "recovery") {
    await runRecoveryCommand(command.args);
    return;
  }
  throw new CliInputError(`${command.name} command is not available yet`);
}

export interface CliMainIo {
  stderr: Pick<NodeJS.WriteStream, "write">;
}

/** Converts command failures into the stable CLI exit contract without writing to stdout. */
export async function runCliMain(
  argv: readonly string[],
  io: CliMainIo = { stderr: process.stderr },
  execute: (args: readonly string[]) => Promise<void> = runVidcomCli,
): Promise<number> {
  try {
    await execute(argv);
    return 0;
  } catch (error) {
    if (error instanceof CliInputError) {
      io.stderr.write(`${error.message.replace(/[\r\n]+/g, " ").trim()}\n`);
      return error.exitCode;
    }
    io.stderr.write("internal_error\n");
    return 1;
  }
}

if (import.meta.main) {
  void runCliMain(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
}
