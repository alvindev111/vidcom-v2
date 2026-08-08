#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";

import { defaultAppDataRoot } from "./next-host";
import { selectWorkspace } from "./workspace-selection";
import { runMcpCommand } from "./commands/mcp";
import { runApproveCommand } from "./commands/approve";
import { runCredentialCommand } from "./commands/credential";
import { runBackupCommand } from "./commands/backup";
import { runRecoveryCommand } from "./commands/recovery";
import { isNodeSentinel, runNodeSentinel } from "./node-sentinel";
import { CliInputError } from "./cli-error";

export { CliInputError } from "./cli-error";

export type VidcomCommandName = "app" | "mcp" | "approve" | "credential" | "backup" | "recovery";

export interface ParsedVidcomCommand {
  name: VidcomCommandName;
  args: string[];
}

export interface AppCommandOptions {
  workspace?: string;
  port?: number;
}

const COMMAND_NAMES = new Set<VidcomCommandName>([
  "app", "mcp", "approve", "credential", "backup", "recovery",
]);

/** Selects one strict top-level command; bare invocation and leading app options alias `vidcom app`. */
export function parseVidcomCommand(argv: readonly string[]): ParsedVidcomCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith("--")) return { name: "app", args: [...argv] };
  if (!COMMAND_NAMES.has(first as VidcomCommandName)) {
    throw new CliInputError(`unknown command: ${first}`);
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate loopback port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntilReady(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`VidCom UI exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* listener is not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("VidCom UI did not become ready within 30 seconds");
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

/** Selects an explicit workspace, launches the production Next host, and opens an authenticated browser handoff. */
export async function runVidcomApp(options: AppCommandOptions = {}): Promise<void> {
  const appDataRoot = defaultAppDataRoot();
  const workspaceRoot = await selectWorkspace({
    explicit: options.workspace ?? process.env.VIDCOM_WORKSPACE,
    appDataRoot,
  });
  const port = options.port ?? await freePort();
  const nonce = createBootstrapNonce();
  const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VIDCOM_APP_DATA: appDataRoot,
      VIDCOM_WORKSPACE: workspaceRoot,
      VIDCOM_BOOTSTRAP_NONCE: nonce,
    },
    stdio: "inherit",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(baseUrl, child);
    openBrowser(`${baseUrl}/?t=${encodeURIComponent(nonce)}`);
    process.stdout.write(`VidCom is running at ${baseUrl}\n`);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM"
        ? resolve()
        : reject(new Error(`VidCom UI exited with code ${code ?? signal}`)));
      const shutdown = () => child.kill("SIGTERM");
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

/** Dispatches the public CLI command tree while preserving bare invocation as the app alias. */
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
