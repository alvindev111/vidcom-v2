import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ResolvedPath } from "@vidcom/core";

/** Optional test seam used to stop a child process at the pre-rename crash boundary. */
export interface AtomicWriteHooks {
  beforeRename?(): Promise<void>;
}

/** Writes a sibling temp file, fsyncs it, renames atomically and fsyncs the directory. */
export async function writeAtomic(
  pathname: ResolvedPath,
  content: string | Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const directory = path.dirname(pathname);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(pathname)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.beforeRename?.();
    await rename(temporary, pathname);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
