import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ContentHash } from "@vidcom/contracts";
import type {
  AbsolutePath,
  StagedFileSource,
  UndoContentEncoding,
  UndoContentPort,
  UndoContentRef,
} from "@vidcom/core";

import { syncDirectory } from "./durability";
import { openRegularFileNoFollow } from "./regular-file";

export const LARGE_PREVIOUS_CONTENT_THRESHOLD = 64 * 1024;

export interface PreviousContentStore {
  /** Persists immutable bytes and returns their canonical digest. */
  put(bytes: Uint8Array): Promise<ContentHash>;
  /** Reads and verifies one immutable object, throwing when it is absent or corrupt. */
  read(hash: ContentHash): Promise<Uint8Array>;
  /** Opens a verified immutable object as a no-follow staged file capability. */
  open?(hash: ContentHash): Promise<StagedFileSource>;
  /** Removes old objects that have neither a durable reference nor a live history lease. */
  cleanupUnreferenced?(referenced: ReadonlySet<string>, olderThan?: Date): Promise<number>;
}

function digest(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

const STREAM_BUFFER_BYTES = 1024 * 1024;

async function digestHandle(handle: FileHandle): Promise<ContentHash> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${hash.digest("hex")}` as ContentHash;
}

async function digestFile(filename: string): Promise<ContentHash> {
  const handle = await openRegularFileNoFollow(filename, "previous-content object is not a regular file");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError("previous-content object is not a regular file");
    return await digestHandle(handle);
  } finally {
    await handle.close();
  }
}

async function copyAndDigest(source: FileHandle, target: FileHandle): Promise<ContentHash> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    await target.write(buffer, 0, bytesRead, position);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  await target.sync();
  return `sha256:${hash.digest("hex")}` as ContentHash;
}

function sameFileState(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/** Immutable content-addressed storage for rollback/revision bytes too large for SQLite hot rows. */
export class LargePreviousContentStore implements PreviousContentStore, UndoContentPort {
  private readonly root: string;
  private readonly liveReferences = new Map<ContentHash, number>();

  constructor(appDataRoot: string) {
    this.root = path.join(appDataRoot, "objects", "previous-content", "sha256");
  }

  private filename(hash: ContentHash): AbsolutePath {
    const hex = hash.slice("sha256:".length);
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new TypeError("previous-content object hash is invalid");
    return path.join(this.root, hex.slice(0, 2), hex) as AbsolutePath;
  }

  private retainObject(hash: ContentHash): void {
    this.liveReferences.set(hash, (this.liveReferences.get(hash) ?? 0) + 1);
  }

  /** Persists caller-owned bytes as one immutable content-addressed object. */
  async put(bytes: Uint8Array): Promise<ContentHash> {
    const hash = digest(bytes);
    const target = this.filename(hash);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true });
    try {
      if (await digestFile(target) !== hash) {
        throw new Error("previous-content object hash collision");
      }
      return hash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await digestFile(target) !== hash) throw new Error("previous-content object hash collision");
    } finally {
      await rm(temporary, { force: true });
    }
    await syncDirectory(directory);
    return hash;
  }

  /** Streams a no-follow regular file into object storage and verifies its declared digest. */
  async putFile(source: StagedFileSource): Promise<ContentHash> {
    const target = this.filename(source.contentHash);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    const sourceHandle = await openRegularFileNoFollow(
      source.sourcePath,
      "undo content source is not a regular file",
    );
    let targetHandle: FileHandle | null = null;
    try {
      const before = await sourceHandle.stat();
      if (!before.isFile()) throw new TypeError("undo content source is not a regular file");
      targetHandle = await open(temporary, "wx", 0o600);
      const actualHash = await copyAndDigest(sourceHandle, targetHandle);
      const after = await sourceHandle.stat();
      if (!sameFileState(before, after) || actualHash !== source.contentHash) {
        throw new Error("undo content source changed or did not match its declared hash");
      }
      await targetHandle.close();
      targetHandle = null;
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await digestFile(target) !== source.contentHash) {
          throw new Error("previous-content object hash collision");
        }
      }
      await syncDirectory(directory);
      return source.contentHash;
    } finally {
      await targetHandle?.close();
      await sourceHandle.close();
      await rm(temporary, { force: true });
    }
  }

  /** Retains bytes either as an isolated inline copy or as a leased object. */
  async retainBytes(
    bytes: Uint8Array,
    encoding: UndoContentEncoding,
    storage: "inline" | "object",
  ): Promise<UndoContentRef> {
    const copy = new Uint8Array(bytes);
    if (storage === "inline") {
      return { kind: "inline", bytes: copy, encoding, contentHash: digest(copy) };
    }
    const contentHash = await this.put(copy);
    this.retainObject(contentHash);
    return { kind: "object", contentHash, encoding };
  }

  /** Retains a staged file as a verified object without loading it into memory. */
  async retainFile(source: StagedFileSource, encoding: UndoContentEncoding): Promise<UndoContentRef> {
    const contentHash = await this.putFile(source);
    this.retainObject(contentHash);
    return { kind: "object", contentHash, encoding };
  }

  /** Resolves inline bytes or returns an opaque staged source for a leased object. */
  async resolve(ref: UndoContentRef): Promise<Uint8Array | StagedFileSource> {
    if (ref.kind === "inline") return new Uint8Array(ref.bytes);
    return this.open(ref.contentHash);
  }

  /** Releases live history leases without deleting bytes synchronously. */
  release(refs: readonly UndoContentRef[]): void {
    for (const ref of refs) {
      if (ref.kind !== "object") continue;
      const count = this.liveReferences.get(ref.contentHash) ?? 0;
      if (count <= 1) this.liveReferences.delete(ref.contentHash);
      else this.liveReferences.set(ref.contentHash, count - 1);
    }
  }

  /** Opens and verifies one immutable object without materializing its bytes. */
  async open(hash: ContentHash): Promise<StagedFileSource> {
    const sourcePath = this.filename(hash);
    if (await digestFile(sourcePath) !== hash) throw new Error("previous-content object integrity check failed");
    return { sourcePath, contentHash: hash };
  }

  /** Compatibility materialization for legacy callers; verification itself stays chunked/no-follow. */
  async read(hash: ContentHash): Promise<Uint8Array> {
    const sourcePath = this.filename(hash);
    const handle = await openRegularFileNoFollow(sourcePath, "previous-content object is not a regular file");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new TypeError("previous-content object is not a regular file");
      const chunks: Buffer[] = [];
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        digest.update(chunk);
        chunks.push(Buffer.from(chunk));
        position += bytesRead;
      }
      if (`sha256:${digest.digest("hex")}` !== hash) {
        throw new Error("previous-content object integrity check failed");
      }
      return Buffer.concat(chunks);
    } finally {
      await handle.close();
    }
  }

  /** Removes only old, unreferenced immutable objects; callers derive references from durable SQLite rows. */
  async cleanupUnreferenced(referenced: ReadonlySet<string>, olderThan?: Date): Promise<number> {
    const retained = new Set([...referenced, ...this.liveReferences.keys()]);
    let removed = 0;
    let prefixes: string[];
    try {
      prefixes = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    for (const prefix of prefixes) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const directory = path.join(this.root, prefix);
      for (const filename of await readdir(directory)) {
        if (!/^[a-f0-9]{64}$/.test(filename)) continue;
        const hash = `sha256:${filename}`;
        if (retained.has(hash)) continue;
        const target = path.join(directory, filename);
        if (olderThan && (await stat(target)).mtimeMs > olderThan.getTime()) continue;
        await rm(target, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
