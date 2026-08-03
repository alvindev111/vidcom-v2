import { spawn } from "node:child_process";

import type { ProcessPort, ProcessRunInput, ProcessRunOutput } from "@vidcom/core";

/** 5 minutes — a VieNeu batch downloading its model on first run, not a routine ffmpeg call. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

/** 64 KB per stream. Engine stderr is for diagnosis; a runaway logger must not fill memory. */
const MAX_CAPTURE_BYTES = 64 * 1024;

/**
 * The only parent variables a child inherits, unless the caller names more.
 *
 * An allowlist rather than `{ ...process.env }`: the daemon's environment holds
 * `ELEVENLABS_API_KEY`, MCP bearer credentials and whatever else the user
 * exported, and none of it belongs in a Python sidecar whose dependency tree is
 * outside our control. What stays is what a process genuinely cannot run
 * without — the loader's search paths, a temp directory, and enough locale for
 * Python to decode Vietnamese filenames.
 */
const INHERITED_ENVIRONMENT = [
  "PATH", "Path", "PATHEXT",
  // Not needed by any sidecar, but Next augments `ProcessEnv` to require it, so
  // dropping it would mean casting the result rather than typing it.
  "NODE_ENV",
  "HOME", "USERPROFILE", "SystemRoot", "SystemDrive", "windir", "COMSPEC",
  "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "LC_CTYPE",
  "PYTHONIOENCODING", "PYTHONUTF8",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
] as const;

/**
 * Parent environment reduced to the allowlist, with the caller's own variables
 * layered on top.
 *
 * Exported for the test that pins the exclusion: a regression here leaks
 * credentials rather than breaking a build, so it needs to be assertable.
 */
export function allowlistedEnvironment(
  parent: NodeJS.ProcessEnv,
  supplied: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_ENVIRONMENT) {
    const value = parent[name];
    if (value !== undefined) environment[name] = value;
  }
  // UTF-8 by default: without it CPython on Windows picks the ANSI code page
  // and a Vietnamese speaker name in a JSON request comes back mojibake.
  environment.PYTHONIOENCODING ??= "utf-8";
  environment.PYTHONUTF8 ??= "1";
  return { NODE_ENV: parent.NODE_ENV, ...environment, ...supplied };
}

/** Node child-process implementation of `ProcessPort`. */
export class NodeProcessRunner implements ProcessPort {
  constructor(private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async run(input: ProcessRunInput): Promise<ProcessRunOutput> {
    const [executable, ...args] = input.command;
    if (!executable) throw new TypeError("process command must name an executable");
    input.signal?.throwIfAborted();

    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: allowlistedEnvironment(process.env, input.environment),
      // No shell: arguments carry user-authored narration paths, and a shell
      // would re-split and glob them. Also lets `detached` give us a killable
      // process group rather than one that outlives its parent.
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const capture = (stream: NodeJS.ReadableStream | null, append: (chunk: string) => void) => {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => append(chunk));
    };
    capture(child.stdout, (chunk) => { stdout = truncate(stdout + chunk); });
    capture(child.stderr, (chunk) => { stderr = truncate(stderr + chunk); });

    let timedOut = false;
    const killTree = () => killProcessTree(child.pid);
    const timeout = setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs ?? this.defaultTimeoutMs);
    const onAbort = () => killTree();
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code: number | null) => resolve(code));
      });
      input.signal?.throwIfAborted();
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function truncate(value: string): string {
  return value.length > MAX_CAPTURE_BYTES ? value.slice(0, MAX_CAPTURE_BYTES) : value;
}

/**
 * Kills the child and anything it spawned.
 *
 * `child.kill()` alone was not enough: the VieNeu sidecar is a Python launcher
 * that forks a worker holding the model, and killing only the launcher left the
 * worker running until the machine was rebooted. POSIX gets the negated pid
 * (the process group created by `detached`); Windows has no groups, so it takes
 * `taskkill /T`.
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }).unref();
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process already exited between the timeout firing and the kill —
    // the exit code we are about to return is the authoritative outcome.
  }
}
