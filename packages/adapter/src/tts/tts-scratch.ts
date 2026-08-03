import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Prefix every scratch directory carries, so a scavenger can recognise its own leftovers. */
const SCRATCH_PREFIX = "tts-";

/**
 * Runs `work` in a fresh empty directory under `scratchRoot` and removes it afterwards.
 *
 * Under app-data, never inside a project: engine intermediates are MP3s,
 * half-written WAVs and request JSON, and a crash mid-batch must not leave any
 * of that in a directory the user backs up or the file watcher reports as a
 * change. Removal is best-effort — a locked handle on Windows must not turn a
 * finished batch into a failure.
 */
export async function withTtsScratch<Value>(
  scratchRoot: string,
  work: (scratchDir: string) => Promise<Value>,
): Promise<Value> {
  await mkdir(scratchRoot, { recursive: true });
  const scratchDir = await mkdtemp(join(scratchRoot, SCRATCH_PREFIX));
  try {
    return await work(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Deletes scratch directories left behind by a process that died mid-batch and
 * returns how many were removed.
 *
 * The `finally` in `withTtsScratch` covers a thrown error, not a kill or a power
 * cut — and what survives those is the narration text the user wrote plus the
 * raw audio of them saying it, sitting in app-data indefinitely. Run at startup,
 * where nothing else owns a scratch directory.
 *
 * `olderThan` guards against deleting a live batch belonging to a second daemon;
 * a missing scratch root is a no-op, not an error.
 */
export async function scavengeTtsScratch(scratchRoot: string, olderThan: Date): Promise<number> {
  const entries = await readdir(scratchRoot, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SCRATCH_PREFIX)) continue;
    const pathname = join(scratchRoot, entry.name);
    const info = await stat(pathname).catch(() => null);
    if (!info || info.mtime > olderThan) continue;
    // Best-effort: a directory another process still holds open on Windows must
    // not turn startup into a failure. The next run tries again.
    if (await rm(pathname, { recursive: true, force: true }).then(() => true, () => false)) removed += 1;
  }
  return removed;
}
