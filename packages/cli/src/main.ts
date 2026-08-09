#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

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
import { DaemonDiscoveryStore, readVidcomSettings } from "@vidcom/adapter";

import {
  isNodeSentinel,
  resolveVerifiedHyperframesRoot,
  runNodeSentinel,
} from "./node-sentinel";
import { CliInputError } from "./cli-error";
import { prepareRuntimeForCli, runtimeAssetSourceForProcess } from "./runtime-paths-source";

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
/**
 * One yield per interrupt, so `render` can tell the first from the second.
 *
 * The handler is removed by `stop()` rather than by the generator's own
 * `finally`: a generator parked on "the next Ctrl+C" is suspended on a promise
 * nothing will settle, and `return()` cannot resume it to run cleanup.
 */
function interruptSignals(): { stream: AsyncIterable<void>; stop: () => void } {
  const queue: Array<() => void> = [];
  let pending = 0;
  const onSignal = () => {
    const waiter = queue.shift();
    if (waiter) waiter();
    else pending += 1;
  };
  process.on("SIGINT", onSignal);

  async function* stream(): AsyncGenerator<void> {
    for (;;) {
      if (pending > 0) {
        pending -= 1;
        yield;
        continue;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      yield;
    }
  }

  return { stream: stream(), stop: () => process.off("SIGINT", onSignal) };
}

/**
 * Dispatches one CLI command and returns the exit status its caller must publish.
 *
 * Doctor and render failures are normal command outcomes, so this function
 * returns their codes without mutating the surrounding process.
 */
export async function runVidcomCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // Dispatched ahead of the public parser on purpose. `parseVidcomCommand`
  // reads any argv starting with `--` as `vidcom app`, so the sentinel would
  // otherwise start the whole application instead of running a script — and
  // silently, since that path raises nothing.
  if (isNodeSentinel(argv)) {
    const settings = await readVidcomSettings();
    const appDataRoot = defaultAppDataRoot(settings);
    await runNodeSentinel(argv, await resolveVerifiedHyperframesRoot(appDataRoot));
    return 0;
  }
  const command = parseVidcomCommand(argv);
  if (command.name === "app") {
    await runVidcomApp(parseAppCommandArgs(command.args));
    return 0;
  }
  if (command.name === "doctor") {
    const options = parseDoctorCommandArgs(command.args);
    const context = await createDoctorContext({ deep: options.deep === true });
    try {
      return await runDoctor({
        context,
        options,
        repair: (failing) => repairRuntime(failing, {
          appDataRoot: context.appDataRoot,
          activeWorkspace: () => context.probes.activeWorkspace()
            .then((result) => result.detail ?? null),
          discovery: new DaemonDiscoveryStore(context.appDataRoot),
          // Wired to the real bootstrap. It used to be a hardwired rejection,
          // so `--repair` could never repair anything — and under strict, where
          // a skipped required component counts as missing, the rejection threw
          // before the report was printed. The packaged smoke found that: a
          // command whose whole job is to say what is wrong, saying nothing.
          reextract: async () => {
            const assetSource = runtimeAssetSourceForProcess();
            if (!assetSource) {
              // Correct answer for a source checkout, which carries no archives.
              throw new CliInputError("this build has no runtime archives to re-extract from");
            }
            await prepareRuntimeForCli(context.appDataRoot, { repair: true, assetSource });
          },
        }),
        // The packaged smoke sets this, and there a skipped required component is
        // a failure rather than a "not yet".
        strict: process.env.VIDCOM_DOCTOR_STRICT === "1",
      });
    } finally {
      // Windows keeps the file locked until the handle is gone, so leaving it
      // open turns any later cleanup into EBUSY.
      await context.close();
    }
  }
  if (command.name === "render") {
    // The handler's lifetime is owned here, not inside the generator. A
    // generator parked on "the next Ctrl+C" cannot be resumed to run its own
    // cleanup, so leaving removal to it would leave the listener installed.
    const signals = interruptSignals();
    const code = await runRenderCommand(command.args, {
      connect: () => connectRenderClient(command.args),
      workspaceSource: () => renderWorkspaceSource(command.args),
      interrupts: signals.stream,
    }).finally(signals.stop);
    // A non-zero render is a normal outcome, not a CLI input error. Return it
    // through the same boundary as doctor so the launcher publishes it once.
    return code;
  }
  if (command.name === "serve") {
    await runServeCommand(command.args);
    return 0;
  }
  if (command.name === "version") {
    // Read from the embedded manifest, which only a packaged build carries.
    // Leaving it out made the artifact answer `null` to "which runtime is
    // this?" — the one question this command exists for, and the packaged smoke
    // is what noticed.
    const runtimeManifest = (() => {
      try {
        const manifest = runtimeAssetSourceForProcess()?.readManifest();
        return manifest
          ? { manifestVersion: manifest.artifactVersion, hyperframes: manifest.versions.hyperframes }
          : null;
      } catch {
        // A manifest this build cannot read is reported as absent rather than
        // taking `version` down: the command's job is to describe the build,
        // and refusing to answer at all is the least useful reply.
        return null;
      }
    })();
    await runVersionCommand(command.args, {
      // The version is read from the package rather than injected at build
      // time, so a source checkout reports the same number it was built from.
      vidcom: VIDCOM_VERSION,
      runtime: runtimeManifest,
      buildCommit: process.env.VIDCOM_BUILD_COMMIT ?? null,
    });
    return 0;
  }
  if (command.name === "mcp") {
    await runMcpCommand(command.args);
    return 0;
  }
  if (command.name === "approve") {
    await runApproveCommand(command.args);
    return 0;
  }
  if (command.name === "credential") {
    // A packaged build hands over the coordinator's database. Opening one here
    // would migrate against the source-relative history folder, which L.1
    // rewrites away so the build machine's paths never ship — inside an
    // artifact that folder does not exist, and `credential issue` came back
    // `internal_error`. The packaged smoke is what found it.
    const assetSource = runtimeAssetSourceForProcess();
    await runCredentialCommand(command.args, {
      appDataRoot: defaultAppDataRoot,
      stdout: process.stdout,
      now: () => new Date(),
      newId: () => `credential_${crypto.randomUUID()}`,
      ...(assetSource === null ? {} : {
        database: async () => {
          const prepared = await prepareRuntimeForCli(defaultAppDataRoot(), { assetSource });
          return { database: prepared.database, release: () => prepared.release() };
        },
      }),
    });
    return 0;
  }
  if (command.name === "backup") {
    await runBackupCommand(command.args);
    return 0;
  }
  if (command.name === "recovery") {
    await runRecoveryCommand(command.args);
    return 0;
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
  execute: (args: readonly string[]) => Promise<number | void> = runVidcomCli,
): Promise<number> {
  try {
    return await execute(argv) ?? 0;
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
