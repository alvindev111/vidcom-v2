import { constants, type Stats } from "node:fs";
import { copyFile, link, mkdir, open, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { ContentHash, RelPath } from "@vidcom/contracts";
import type { ResolvedPath, StagedAsset, StagedAssetPort } from "@vidcom/core";

import { syncDirectory } from "./durability";
import { openRegularFileNoFollow } from "./regular-file";

export interface StagedAssetOperations {
  copySource(source: FileHandle, destination: FileHandle): Promise<void>;
  link: typeof link;
  copyFile: typeof copyFile;
}

const DEFAULT_OPERATIONS: StagedAssetOperations = Object.freeze({
  async copySource(source: FileHandle, destination: FileHandle) {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
  },
  link,
  copyFile,
});

function sameSourceState(before: Stats, after: Stats): boolean {
  return before.isFile()
    && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/** Stages bytes in app-data and installs them with no-overwrite hard-link semantics. */
export class AppDataAssetStager implements StagedAssetPort {
  constructor(
    private readonly appDataRoot: string,
    private readonly operations: StagedAssetOperations = DEFAULT_OPERATIONS,
  ) {}

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
    return this.staged(target, targetPath, temporaryPath, contentHash, true);
  }

  async stageFile(
    target: ResolvedPath,
    targetPath: RelPath,
    sourcePath: import("@vidcom/core").AbsolutePath,
    expectedHash: ContentHash,
    options: { createParent?: boolean } = {},
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
    const source = await openRegularFileNoFollow(sourcePath, "staged artifact source is not a regular file");
    let destination: Awaited<ReturnType<typeof open>> | null = null;
    try {
      destination = await open(temporaryPath, "wx", 0o600);
      const before = await source.stat();
      if (!before.isFile()) throw new Error("staged artifact source is not a regular file");
      await this.operations.copySource(source, destination);
      await destination.sync();
      if (!sameSourceState(before, await source.stat())) {
        throw new Error("staged artifact source changed during copy");
      }
    } catch (error) {
      await Promise.allSettled([source.close(), destination?.close()]);
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await Promise.all([source.close(), destination.close()]);
    const actual = await hashFile(temporaryPath);
    if (actual !== expectedHash) {
      await rm(temporaryPath, { force: true });
      throw new Error("staged artifact source hash changed during copy");
    }
    return this.staged(target, targetPath, temporaryPath, actual, options.createParent ?? true);
  }

  private staged(
    target: ResolvedPath,
    targetPath: RelPath,
    temporaryPath: string,
    contentHash: ContentHash,
    createParent: boolean,
  ): StagedAsset {
    let installed = false;
    return {
      temporaryPath,
      targetPath,
      contentHash,
      commit: async () => {
        const targetDirectory = path.dirname(target);
        if (createParent) await mkdir(targetDirectory, { recursive: true });
        let localPublishPath: string | null = null;
        try { await this.operations.link(temporaryPath, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          localPublishPath = path.join(targetDirectory, `.vidcom-${randomUUID()}.publish`);
          try {
            await this.operations.copyFile(temporaryPath, localPublishPath, constants.COPYFILE_EXCL);
            const localHandle = await open(localPublishPath, "r+");
            try { await localHandle.sync(); } finally { await localHandle.close(); }
            await this.operations.link(localPublishPath, target);
          } finally {
            await rm(localPublishPath, { force: true });
          }
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
            if (await hashFile(target) === contentHash) await rm(target, { force: true });
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
  const handle = await openRegularFileNoFollow(pathname, "staged target is not a regular file");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError("staged target is not a regular file");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${digest.digest("hex")}` as ContentHash;
  } finally {
    await handle.close();
  }
}
