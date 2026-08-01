import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import type { ContentHash, DomainEvent, ProjectId, RelPath } from "@vidcom/contracts";
import type { ClockPort, EventOutboxPort, ProjectCache, ProjectRef, WorkspacePort } from "@vidcom/core";

import type { VidcomDatabase } from "../db/client";

export const WATCH_DEBOUNCE_MS = 150;

function key(projectId: ProjectId, relativePath: RelPath): string {
  return `${projectId}\u0000${relativePath}`;
}

/** Shared own-write hash registry consumed once by filesystem notifications. */
export class WrittenHashTracker {
  private readonly hashes = new Map<string, ContentHash>();

  record(projectId: ProjectId, relativePath: RelPath, hash: ContentHash): void {
    this.hashes.set(key(projectId, relativePath), hash);
  }

  consume(projectId: ProjectId, relativePath: RelPath, hash: ContentHash | null): boolean {
    const itemKey = key(projectId, relativePath);
    const expected = this.hashes.get(itemKey);
    if (expected === undefined) return false;
    this.hashes.delete(itemKey);
    return expected === hash;
  }
}

function digest(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

/** Debounced workspace watcher that emits only external logical file changes. */
export class WorkspaceWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly observedHashes = new Map<string, ContentHash | null>();

  constructor(
    private readonly workspace: WorkspacePort,
    private readonly database: VidcomDatabase,
    private readonly outbox: EventOutboxPort,
    private readonly cache: ProjectCache,
    private readonly tracker: WrittenHashTracker,
    private readonly clock: ClockPort,
    private readonly debounceMs = WATCH_DEBOUNCE_MS,
  ) {}

  async start(): Promise<void> {
    for (const ref of await this.workspace.listProjects()) {
      const watcher = watch(ref.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const relative = String(filename).split(path.sep).join("/") as RelPath;
        if (relative.split("/").some((part) => [".git", ".hyperframes", "node_modules"].includes(part))) return;
        const basename = path.posix.basename(relative);
        if (basename.startsWith(".") && basename.endsWith(".tmp")) return;
        this.debounce(ref, relative);
      });
      this.watchers.push(watcher);
    }
  }

  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
  }

  /** Public deterministic seam used by integration tests after a real filesystem edit. */
  async observe(ref: ProjectRef, relativePath: RelPath): Promise<void> {
    const absolute = path.join(ref.root, relativePath);
    let hash: ContentHash | null = null;
    try { hash = digest(await readFile(absolute)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const itemKey = key(ref.id, relativePath);
    if (this.observedHashes.has(itemKey) && this.observedHashes.get(itemKey) === hash) return;
    if (this.tracker.consume(ref.id, relativePath, hash)) {
      this.observedHashes.set(itemKey, hash);
      return;
    }

    if (relativePath === "preview-settings.json") {
      const persistedHash = hash ?? "sha256:deleted";
      const state = this.database.get<{ contentHash: string }>(sql`
        SELECT content_hash AS contentHash FROM entity_state
        WHERE project_id = ${ref.id} AND entity = 'preview-settings'
      `);
      if (state?.contentHash !== persistedHash) {
        this.database.run(sql`
          UPDATE entity_state SET revision = revision + 1, content_hash = ${persistedHash},
            last_actor = 'cli-external', updated_at = ${this.clock.now().toISOString()}
          WHERE project_id = ${ref.id} AND entity = 'preview-settings'
        `);
      }
    }
    const event: DomainEvent = {
      type: "file.changed",
      projectId: ref.id,
      payload: { path: relativePath, source: "external" },
    };
    await this.outbox.append(event);
    this.observedHashes.set(itemKey, hash);
    this.cache.handleEvent(event);
  }

  private debounce(ref: ProjectRef, relativePath: RelPath): void {
    const itemKey = key(ref.id, relativePath);
    const prior = this.pending.get(itemKey);
    if (prior) clearTimeout(prior);
    this.pending.set(itemKey, setTimeout(() => {
      this.pending.delete(itemKey);
      void this.observe(ref, relativePath).catch(() => this.debounce(ref, relativePath));
    }, this.debounceMs));
  }
}
