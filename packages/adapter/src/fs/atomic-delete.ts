import { unlink } from "node:fs/promises";
import path from "node:path";

import type { ResolvedPath } from "@vidcom/core";

import { syncDirectory } from "./durability";

/** Unlinks one resolved file atomically and fsyncs its directory; an absent target is already deleted. */
export async function deleteAtomic(pathname: ResolvedPath): Promise<void> {
  try {
    await unlink(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  await syncDirectory(path.dirname(pathname));
}
