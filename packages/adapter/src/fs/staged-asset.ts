import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { ContentHash, RelPath } from "@vidcom/contracts";
import type { ResolvedPath, StagedAsset, StagedAssetPort } from "@vidcom/core";

/** Stages bytes in app-data and installs them with no-overwrite hard-link semantics. */
export class AppDataAssetStager implements StagedAssetPort {
  constructor(private readonly appDataRoot: string) {}

  async stage(target: ResolvedPath, targetPath: RelPath, bytes: Uint8Array): Promise<StagedAsset> {
    try {
      await stat(target);
      throw new Error("asset target already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const directory = path.join(this.appDataRoot, "tmp");
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `bgm-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    let installed = false;
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
    return {
      temporaryPath,
      targetPath,
      contentHash,
      commit: async () => {
        const targetDirectory = path.dirname(target);
        await mkdir(targetDirectory, { recursive: true });
        try { await link(temporaryPath, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await copyFile(temporaryPath, target, constants.COPYFILE_EXCL);
        }
        installed = true;
        const targetHandle = await open(target, "r");
        try { await targetHandle.sync(); } finally { await targetHandle.close(); }
        await unlink(temporaryPath);
        const directoryHandle = await open(targetDirectory, "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      },
      cleanup: async () => {
        await rm(temporaryPath, { force: true });
        if (installed) {
          try {
            const actual = `sha256:${createHash("sha256").update(await readFile(target)).digest("hex")}`;
            if (actual === contentHash) await rm(target, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      },
    };
  }
}
