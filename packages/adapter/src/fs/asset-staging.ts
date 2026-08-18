import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ContentHash } from "@vidcom/contracts";
import {
  AssetStagingLimitError,
  type AbsolutePath,
  type AssetStagingPort,
  type ProjectRef,
  type StagedFileSource,
  type StagedWriter,
} from "@vidcom/core";

import { syncDirectory } from "./durability";

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("asset staging directory is unsafe");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const created = await lstat(directory);
  if (!created.isDirectory() || created.isSymbolicLink()) throw new TypeError("asset staging directory is unsafe");
}

async function stagingDirectory(ref: ProjectRef): Promise<string> {
  await ensureRealDirectory(ref.root);
  const internal = path.join(ref.root, ".vidcom");
  await ensureRealDirectory(internal);
  const temporary = path.join(internal, "tmp");
  await ensureRealDirectory(temporary);
  return temporary;
}

class FsStagedWriter implements StagedWriter {
  private bytes = 0;
  private state: "open" | "finalized" | "discarded" = "open";
  private source: StagedFileSource | null = null;
  private readonly digest = createHash("sha256");

  constructor(
    private handle: FileHandle | null,
    private readonly sourcePath: AbsolutePath,
    private readonly maxBytes: number,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.state !== "open" || !this.handle) throw new TypeError("asset staging writer is not open");
    const actual = this.bytes + chunk.byteLength;
    if (actual > this.maxBytes) throw new AssetStagingLimitError(this.maxBytes, actual);
    let written = 0;
    while (written < chunk.byteLength) {
      const result = await this.handle.write(chunk, written, chunk.byteLength - written, this.bytes + written);
      if (result.bytesWritten <= 0) throw new Error("asset staging write made no progress");
      written += result.bytesWritten;
    }
    this.digest.update(chunk);
    this.bytes = actual;
  }

  async finalize(): Promise<StagedFileSource> {
    if (this.state === "finalized" && this.source) return this.source;
    if (this.state !== "open" || !this.handle) throw new TypeError("asset staging writer was discarded");
    await this.handle.sync();
    await this.handle.close();
    this.handle = null;
    await syncDirectory(path.dirname(this.sourcePath));
    this.source = {
      sourcePath: this.sourcePath,
      contentHash: `sha256:${this.digest.digest("hex")}` as ContentHash,
    };
    this.state = "finalized";
    return this.source;
  }

  async discard(): Promise<void> {
    if (this.state === "discarded") return;
    const handle = this.handle;
    this.handle = null;
    const closed = handle ? await Promise.allSettled([handle.close()]) : [];
    await rm(this.sourcePath, { force: true });
    this.state = "discarded";
    if (closed[0]?.status === "rejected") throw closed[0].reason;
  }
}

export class FsAssetStaging implements AssetStagingPort {
  async open(ref: ProjectRef, hint: { filename: string; maxBytes: number }): Promise<StagedWriter> {
    if (!hint.filename || !Number.isSafeInteger(hint.maxBytes) || hint.maxBytes < 0) {
      throw new TypeError("asset staging hint is invalid");
    }
    const directory = await stagingDirectory(ref);
    const sourcePath = path.join(directory, `asset-${randomUUID()}.tmp`) as AbsolutePath;
    const handle = await open(sourcePath, "wx", 0o600);
    return new FsStagedWriter(handle, sourcePath, hint.maxBytes);
  }

  /** Startup hook used by task 5.2c; only this adapter's expired files are in scope. */
  async cleanupExpired(ref: ProjectRef, olderThan: Date): Promise<number> {
    const directory = await stagingDirectory(ref);
    let removed = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.startsWith("asset-") || !entry.name.endsWith(".tmp")) continue;
      const target = path.join(directory, entry.name);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mtimeMs >= olderThan.getTime()) continue;
      await rm(target, { force: true });
      removed += 1;
    }
    return removed;
  }
}
