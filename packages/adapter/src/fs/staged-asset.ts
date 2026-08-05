import { constants, createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

import type { ContentHash, RelPath } from "@vidcom/contracts";
import type { ResolvedPath, StagedAsset, StagedAssetPort } from "@vidcom/core";

import { syncDirectory } from "./durability";

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
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
    return this.staged(target, targetPath, temporaryPath, contentHash);
  }

  async stageFile(
    target: ResolvedPath,
    targetPath: RelPath,
    sourcePath: import("@vidcom/core").AbsolutePath,
    expectedHash: ContentHash,
  ): Promise<StagedAsset> {
    try {
      await stat(target);
      throw new Error("asset target already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const directory = path.join(this.appDataRoot, "tmp");
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `artifact-${randomUUID()}.tmp`);
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let destination: Awaited<ReturnType<typeof open>> | null = null;
    try {
      destination = await open(temporaryPath, "wx", 0o600);
      if (!(await source.stat()).isFile()) throw new Error("staged artifact source is not a regular file");
      await pipeline(
        source.createReadStream({ autoClose: false }),
        destination.createWriteStream({ autoClose: false }),
      );
      await destination.sync();
    } catch (error) {
      if (destination) {
        await destination.close();
        destination = null;
      }
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      await source.close();
      if (destination) await destination.close();
    }
    const actual = await hashFile(temporaryPath);
    if (actual !== expectedHash) {
      await rm(temporaryPath, { force: true });
      throw new Error("staged artifact source hash changed during copy");
    }
    return this.staged(target, targetPath, temporaryPath, actual);
  }

  private staged(
    target: ResolvedPath,
    targetPath: RelPath,
    temporaryPath: string,
    contentHash: ContentHash,
  ): StagedAsset {
    let installed = false;
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
        // "r+" not "r": Windows refuses FlushFileBuffers on a read-only handle.
        const targetHandle = await open(target, "r+");
        try { await targetHandle.sync(); } finally { await targetHandle.close(); }
        await unlink(temporaryPath);
        await syncDirectory(targetDirectory);
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

async function hashFile(pathname: string): Promise<ContentHash> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) digest.update(chunk as Buffer);
  return `sha256:${digest.digest("hex")}` as ContentHash;
}
