import { open, unlink } from "node:fs/promises";
import path from "node:path";

import type { ResolvedPath } from "@vidcom/core";

/** Unlinks one resolved file atomically and fsyncs its directory; an absent target is already deleted. */
export async function deleteAtomic(pathname: ResolvedPath): Promise<void> {
  try {
    await unlink(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const directoryHandle = await open(path.dirname(pathname), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
