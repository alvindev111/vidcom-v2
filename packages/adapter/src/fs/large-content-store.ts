import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ContentHash } from "@vidcom/contracts";

import { syncDirectory } from "./durability";

export const LARGE_PREVIOUS_CONTENT_THRESHOLD = 64 * 1024;

export interface PreviousContentStore {
  put(bytes: Uint8Array): Promise<ContentHash>;
  read(hash: ContentHash): Promise<Uint8Array>;
  cleanupUnreferenced?(referenced: ReadonlySet<string>, olderThan?: Date): Promise<number>;
}

function digest(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

/** Immutable content-addressed storage for rollback/revision bytes too large for SQLite hot rows. */
export class LargePreviousContentStore implements PreviousContentStore {
  private readonly root: string;

  constructor(appDataRoot: string) {
    this.root = path.join(appDataRoot, "objects", "previous-content", "sha256");
  }

  private filename(hash: ContentHash): string {
    const hex = hash.slice("sha256:".length);
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new TypeError("previous-content object hash is invalid");
    return path.join(this.root, hex.slice(0, 2), hex);
  }

  async put(bytes: Uint8Array): Promise<ContentHash> {
    const hash = digest(bytes);
    const target = this.filename(hash);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true });
    try {
      if (digest(await readFile(target)) !== hash) {
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
      if (digest(await readFile(target)) !== hash) throw new Error("previous-content object hash collision");
    } finally {
      await rm(temporary, { force: true });
    }
    await syncDirectory(directory);
    return hash;
  }

  async read(hash: ContentHash): Promise<Uint8Array> {
    const bytes = await readFile(this.filename(hash));
    if (digest(bytes) !== hash) throw new Error("previous-content object integrity check failed");
    return bytes;
  }

  /** Removes only old, unreferenced immutable objects; callers derive references from durable SQLite rows. */
  async cleanupUnreferenced(referenced: ReadonlySet<string>, olderThan?: Date): Promise<number> {
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
        if (referenced.has(hash)) continue;
        const target = path.join(directory, filename);
        if (olderThan && (await stat(target)).mtimeMs > olderThan.getTime()) continue;
        await rm(target, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
