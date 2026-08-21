import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { type ContentHash, type RelPath } from "@vidcom/contracts";
import { type AbsolutePath, type CatalogItem } from "@vidcom/core";

/**
 * Verified payload cache for materialized catalog packages (Design §5.16).
 *
 * Three invariants. A package is published whole or not at all, through a
 * staging directory and one rename, so a half-downloaded closure can never be
 * read as a package. Bytes are counted as they arrive, never trusted from
 * `Content-Length`. And a package in use is pinned, so the global LRU budget can
 * reclaim space without pulling files out from under an install in progress.
 */

export interface CatalogPackageLimits {
  closureItems: number;
  files: number;
  fileBytes: number;
  packageBytes: number;
  cacheBytes: number;
}

/** Byte and item ceilings applied to every materialization. */
export const CATALOG_PACKAGE_LIMITS: Readonly<CatalogPackageLimits> = Object.freeze({
  closureItems: 256,
  files: 1_024,
  fileBytes: 25 * 1024 * 1024,
  packageBytes: 250 * 1024 * 1024,
  cacheBytes: 1024 * 1024 * 1024,
});

const HASH_BUFFER_BYTES = 16 * 1024;

export interface CatalogPackageFile {
  path: RelPath;
  contentHash: ContentHash;
  /** Absolute app-data path; a capability, never bytes. */
  sourcePath: AbsolutePath;
  encoding: "utf8" | "binary";
}

export interface CatalogPackageEntry {
  item: CatalogItem;
  files: CatalogPackageFile[];
}

interface PackageRecord {
  key: string;
  root: string;
  bytes: number;
  usedAt: number;
}

/** Stable, filesystem-safe directory name for one package identity. */
export function catalogPackageKey(name: string, version: string): string {
  return createHash("sha256").update(`${name}\u0000${version}`, "utf8").digest("hex");
}

export class CatalogPackageCache {
  readonly #root: string;
  readonly #stagingRoot: string;
  readonly #limits: CatalogPackageLimits;
  readonly #now: () => number;
  readonly #pins = new Map<string, number>();

  constructor(options: { root: string; limits?: CatalogPackageLimits; now?: () => number }) {
    this.#root = path.join(options.root, "packages");
    this.#stagingRoot = path.join(options.root, "staging");
    this.#limits = options.limits ?? CATALOG_PACKAGE_LIMITS;
    this.#now = options.now ?? (() => Date.now());
  }

  get limits(): CatalogPackageLimits {
    return this.#limits;
  }

  /** Number of packages currently held by a caller; zero at rest. */
  pinnedCount(): number {
    return [...this.#pins.values()].filter((count) => count > 0).length;
  }

  packageRoot(key: string): string {
    return path.join(this.#root, key);
  }

  /** Opens a staging directory that is discarded unless it is published. */
  async stage(): Promise<{ root: string; discard(): Promise<void> }> {
    const root = path.join(this.#stagingRoot, randomUUID());
    await mkdir(root, { recursive: true, mode: 0o700 });
    return {
      root,
      discard: async () => { await rm(root, { recursive: true, force: true }); },
    };
  }

  /**
   * Moves a staged package into place as one directory rename.
   *
   * A pre-existing directory for the same identity wins: the same identity means
   * the same bytes, so re-downloading is wasted work rather than an update.
   */
  async publish(key: string, stagedRoot: string): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const target = this.packageRoot(key);
    try {
      await rename(stagedRoot, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      await rm(stagedRoot, { recursive: true, force: true });
    }
  }

  /** Pins a package so the LRU cannot reclaim it while a caller holds it. */
  pin(key: string): () => Promise<void> {
    this.#pins.set(key, (this.#pins.get(key) ?? 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const next = (this.#pins.get(key) ?? 1) - 1;
      if (next <= 0) this.#pins.delete(key);
      else this.#pins.set(key, next);
      await this.enforceBudget();
    };
  }

  async touch(key: string): Promise<void> {
    const target = this.packageRoot(key);
    try {
      const handle = await open(target, "r");
      await handle.close();
    } catch { /* the record's mtime is refreshed opportunistically */ }
    this.#usedAt.set(key, this.#now());
  }

  readonly #usedAt = new Map<string, number>();

  /** Drops least-recently-used unpinned packages until the budget is met. */
  async enforceBudget(): Promise<void> {
    const records = await this.#records();
    let total = records.reduce((sum, record) => sum + record.bytes, 0);
    if (total <= this.#limits.cacheBytes) return;
    const evictable = records
      .filter((record) => (this.#pins.get(record.key) ?? 0) === 0)
      .sort((left, right) => left.usedAt - right.usedAt);
    for (const record of evictable) {
      if (total <= this.#limits.cacheBytes) return;
      await rm(record.root, { recursive: true, force: true });
      this.#usedAt.delete(record.key);
      total -= record.bytes;
    }
  }

  async #records(): Promise<PackageRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch {
      return [];
    }
    const records: PackageRecord[] = [];
    for (const key of names) {
      const root = path.join(this.#root, key);
      const metadata = await stat(root).catch(() => null);
      if (!metadata?.isDirectory()) continue;
      records.push({
        key,
        root,
        bytes: await directoryBytes(root),
        usedAt: this.#usedAt.get(key) ?? metadata.mtimeMs,
      });
    }
    return records;
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const metadata = await stat(path.join(entry.parentPath, entry.name)).catch(() => null);
    total += metadata?.size ?? 0;
  }
  return total;
}

/** Streams a response body into a staged file, counting the bytes it actually reads. */
export async function writeStagedPayload(
  response: Response,
  target: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: number; contentHash: ContentHash }> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    if (!response.body) throw new CatalogPayloadError("too_large", "catalog payload response was empty");
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (signal.aborted) throw new CatalogPayloadError("aborted", "catalog payload download was aborted");
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        // The declared length is advisory; only these counted bytes bound the file.
        if (bytes > maxBytes) {
          throw new CatalogPayloadError("too_large", "catalog payload file exceeds its limit");
        }
        hash.update(next.value);
        await handle.write(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, contentHash: `sha256:${hash.digest("hex")}` as ContentHash };
}

export type CatalogPayloadFailureCode =
  | "not_found"
  | "version_mismatch"
  | "too_large"
  | "aborted"
  | "unavailable"
  | "integrity_mismatch";

/** Expected materialization failure with a stable code for the route mapping. */
export class CatalogPayloadError extends Error {
  constructor(
    readonly code: CatalogPayloadFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CatalogPayloadError";
  }
}

/** Reads a published package file's digest with a bounded buffer. */
export async function hashStagedFile(target: string): Promise<ContentHash | null> {
  let handle;
  try {
    handle = await open(target, "r");
  } catch {
    return null;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest("hex")}` as ContentHash;
  } finally {
    await handle.close();
  }
}
