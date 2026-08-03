import { open } from "node:fs/promises";

/**
 * Flushes a directory entry so a completed rename or unlink survives a crash.
 *
 * POSIX needs this: the file's own fsync says nothing about the directory entry
 * pointing at it. Windows has no equivalent — `FlushFileBuffers` rejects a
 * directory handle with `EPERM` — and NTFS journals its own metadata, so the
 * entry is already durable once the rename returns. Skipping the call there is
 * the correct behaviour on that platform, not a weaker guarantee.
 */
export async function syncDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
