/** One child process invocation described without naming a spawn implementation. */
export interface ProcessRunInput {
  /** Executable first, arguments after; never a shell string, so nothing is word-split or globbed. */
  command: readonly string[];
  cwd?: string;
  /**
   * Layered on top of a minimal allowlist of parent variables — the child does
   * NOT inherit the daemon's full environment. Anything the command needs
   * beyond a loader path and a temp directory must be named here, and secrets
   * belonging to other providers never reach it.
   */
  environment?: Record<string, string>;
  /** Defaults to the adapter's own ceiling; expiry kills the process tree and returns a non-zero exit. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Captured result of a finished child process. */
export interface ProcessRunOutput {
  /** `null` when the process was terminated by a signal instead of exiting on its own. */
  exitCode: number | null;
  /** Truncated at the adapter's capture ceiling; never assume the full stream is present. */
  stdout: string;
  stderr: string;
  /** Whether the adapter, not the child, ended the process because `timeoutMs` elapsed. */
  timedOut: boolean;
}

/** Child-process seam so Core can orchestrate ffmpeg and model sidecars without importing `node:child_process`. */
export interface ProcessPort {
  /**
   * Runs one command to completion and returns its captured output.
   *
   * A non-zero `exitCode` is a normal return, not a throw — callers decide what
   * a failing exit means. Throws only when the process could not be started at
   * all (executable missing) or when `signal` aborts. Killing on timeout or
   * abort terminates the whole process tree: the VieNeu sidecar spawns Python
   * workers of its own, and killing only the direct child left them holding the
   * GPU.
   */
  run(input: ProcessRunInput): Promise<ProcessRunOutput>;
}
