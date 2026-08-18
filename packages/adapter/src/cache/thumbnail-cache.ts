import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, utimes } from "node:fs/promises";
import path from "node:path";

import type { ProjectId } from "@vidcom/contracts";
import type { ResolvedPath, ThumbnailCachePort } from "@vidcom/core";

import { syncDirectory } from "../fs/durability";
import { writeAtomic } from "../fs/atomic-write";

const DEFAULT_DISK_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_MEMORY_LIMIT = 128;
const KEY_PATTERN = /^[0-9a-f]{64}$/u;

export interface ThumbnailCacheOptions {
  diskBudgetBytes?: number;
  memoryLimit?: number;
  clock?: () => Date;
}

interface DiskEntry {
  filename: string;
  memoryKey: string;
  namespaceRoot: string;
  size: number;
  modifiedAtMs: number;
}

function projectNamespace(projectId: ProjectId): string {
  return createHash("sha256").update(projectId).digest("hex");
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** App-data-only project namespace with global disk LRU and image-count memory LRU. */
export class ThumbnailCacheAdapter implements ThumbnailCachePort {
  private readonly root: string;
  private readonly diskBudgetBytes: number;
  private readonly memoryLimit: number;
  private readonly clock: () => Date;
  private readonly memory = new Map<string, Uint8Array>();
  private maintenance: Promise<void> = Promise.resolve();

  constructor(appDataRoot: string, options: ThumbnailCacheOptions = {}) {
    if (!path.isAbsolute(appDataRoot)) throw new TypeError("thumbnail app-data root must be absolute");
    this.root = path.join(appDataRoot, "cache", "thumbnails");
    this.diskBudgetBytes = options.diskBudgetBytes ?? DEFAULT_DISK_BUDGET_BYTES;
    this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.clock = options.clock ?? (() => new Date());
    if (!Number.isSafeInteger(this.diskBudgetBytes) || this.diskBudgetBytes < 1
      || !Number.isSafeInteger(this.memoryLimit) || this.memoryLimit < 1) {
      throw new TypeError("thumbnail cache limits must be positive safe integers");
    }
  }

  async get(projectId: ProjectId, renderKey: string): Promise<Uint8Array | null> {
    this.assertKey(renderKey);
    const namespace = projectNamespace(projectId);
    const memoryKey = `${namespace}/${renderKey}`;
    const hit = this.memory.get(memoryKey);
    if (hit) {
      this.memory.delete(memoryKey);
      this.memory.set(memoryKey, hit);
      return new Uint8Array(hit);
    }
    const filename = path.join(this.root, namespace, `${renderKey}.webp`);
    try {
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        if (!(await handle.stat()).isFile()) return null;
        bytes = new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
      const now = this.clock();
      await utimes(filename, now, now).catch(() => {});
      this.remember(memoryKey, bytes);
      return new Uint8Array(bytes);
    } catch (error) {
      if (absent(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
      throw error;
    }
  }

  async put(projectId: ProjectId, renderKey: string, bytes: Uint8Array): Promise<void> {
    this.assertKey(renderKey);
    const operation = this.maintenance.then(async () => {
      const namespace = projectNamespace(projectId);
      const namespaceRoot = path.join(this.root, namespace);
      await this.ensureDirectory(namespaceRoot);
      const filename = path.join(namespaceRoot, `${renderKey}.webp`);
      await writeAtomic(filename as ResolvedPath, bytes);
      const now = this.clock();
      await utimes(filename, now, now);
      this.remember(`${namespace}/${renderKey}`, bytes);
      await this.pruneDisk();
    });
    this.maintenance = operation.catch(() => {});
    return operation;
  }

  private assertKey(renderKey: string): void {
    if (!KEY_PATTERN.test(renderKey)) throw new TypeError("thumbnail cache key must be 64 lowercase hex characters");
  }

  private remember(memoryKey: string, bytes: Uint8Array): void {
    this.memory.delete(memoryKey);
    this.memory.set(memoryKey, new Uint8Array(bytes));
    while (this.memory.size > this.memoryLimit) this.memory.delete(this.memory.keys().next().value!);
  }

  private async ensureDirectory(namespaceRoot: string): Promise<void> {
    await mkdir(namespaceRoot, { recursive: true, mode: 0o700 });
    for (const directory of [this.root, namespaceRoot]) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError("thumbnail cache directory is unsafe");
      }
    }
  }

  private async pruneDisk(): Promise<void> {
    const entries: DiskEntry[] = [];
    for (const namespace of await readdir(this.root, { withFileTypes: true })) {
      if (!namespace.isDirectory() || namespace.isSymbolicLink() || !KEY_PATTERN.test(namespace.name)) continue;
      const namespaceRoot = path.join(this.root, namespace.name);
      for (const entry of await readdir(namespaceRoot, { withFileTypes: true })) {
        const renderKey = entry.name.match(/^([0-9a-f]{64})\.webp$/u)?.[1];
        if (!renderKey || !entry.isFile() || entry.isSymbolicLink()) continue;
        const filename = path.join(namespaceRoot, entry.name);
        const metadata = await lstat(filename);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        entries.push({
          filename,
          namespaceRoot,
          memoryKey: `${namespace.name}/${renderKey}`,
          size: metadata.size,
          modifiedAtMs: metadata.mtimeMs,
        });
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const changed = new Set<string>();
    for (const entry of entries.sort((left, right) =>
      left.modifiedAtMs - right.modifiedAtMs || left.filename.localeCompare(right.filename, "en"))) {
      if (total <= this.diskBudgetBytes) break;
      await rm(entry.filename, { force: true });
      total -= entry.size;
      changed.add(entry.namespaceRoot);
      this.memory.delete(entry.memoryKey);
    }
    await Promise.all([...changed].map((directory) => syncDirectory(directory)));
    if (changed.size > 0) await syncDirectory(this.root);
  }
}
