import { spawn } from "node:child_process";

import type { DaemonRecord } from "@vidcom/adapter";

export interface SpawnDaemonOptions {
  workspaceRoot: string;
  /** The executable to re-run. In a packaged build this is the artifact itself. */
  executable?: string;
  /** Arguments that come before the mode, e.g. the script path outside a SEA. */
  prefixArgs?: readonly string[];
  spawnProcess?: typeof spawn;
}

/**
 * Arguments for the daemon a client starts on its own behalf.
 *
 * `--ensure` is what marks it as started on demand, and that is the only thing
 * that ever lets a daemon retire itself. Note what is absent: no browser flag.
 * A daemon started because an agent needed one must not open a window on
 * somebody's screen.
 */
export function ensureDaemonArgs(workspaceRoot: string): string[] {
  return ["serve", "--ensure", "--workspace", workspaceRoot];
}

/**
 * Starts a daemon and stops caring about it.
 *
 * Detached and with its streams discarded, because the client that started it
 * will exit long before the daemon does — and a child sharing this process's
 * stdio would keep writing into a pipe nobody reads, or die with the parent.
 * stdout in particular belongs to the JSON-RPC stream when the caller is the
 * bridge.
 */
export function spawnEnsuredDaemon(options: SpawnDaemonOptions): void {
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(
    options.executable ?? process.execPath,
    [...(options.prefixArgs ?? []), ...ensureDaemonArgs(options.workspaceRoot)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/** Waits for the daemon to publish, then hands back what it published. */
export async function waitForDaemonRecord(
  read: () => Promise<DaemonRecord | null>,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DaemonRecord | null> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Polling a file rather than watching the child: the daemon that ends up
  // serving this workspace may not be the child at all — losing the lease race
  // means somebody else's daemon publishes, and a watcher on our own process
  // would never see it.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await read();
    if (record) return record;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}
