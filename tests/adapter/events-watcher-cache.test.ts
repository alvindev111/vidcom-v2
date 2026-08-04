import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  migrateDatabase,
  MutationJournal,
  openVidcomDatabase,
  SqliteEventOutbox,
  WATCH_DEBOUNCE_MS,
  WorkspaceFs,
  WorkspaceLease,
  WorkspaceWatcher,
  WrittenHashTracker,
} from "@vidcom/adapter";
import type { ContentHash, ProjectId } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  ProjectCache,
  WriteAuthority,
  type AbsolutePath,
  type CompositionModel,
} from "@vidcom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbOne, dbRun } from "../support/database";

const roots: string[] = [];
const projectId = "project_watch" as ProjectId;

function mutableClock(initial: string) {
  let time = new Date(initial).getTime();
  return { now: () => new Date(time), advance(ms: number) { time += ms; } };
}

function hash(content: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition was not observed before timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("event outbox, watcher and project cache", () => {
  it("restarts a failed filesystem watcher and cancels future restarts on close", async () => {
    const ref = {
      id: projectId,
      slug: "watch",
      root: "/workspace/watch" as AbsolutePath,
      entry: "index.html",
    } as const;
    const created: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = [];
    const factory = () => {
      const value = Object.assign(new EventEmitter(), { close: vi.fn() });
      created.push(value);
      return value as unknown as FSWatcher;
    };
    const watcher = new WorkspaceWatcher(
      { async listProjects() { return [ref]; } } as never,
      {} as never,
      {} as never,
      new ProjectCache(),
      new WrittenHashTracker(),
      mutableClock("2026-08-01T00:00:00.000Z"),
      1,
      factory,
    );
    await watcher.start();
    created[0]!.emit("error", new Error("watch failed"));
    await eventually(async () => created.length === 2);
    expect(created[0]!.close).toHaveBeenCalledOnce();
    watcher.close();
    const countAfterClose = created.length;
    created[1]!.emit("error", new Error("closed"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created).toHaveLength(countAfterClose);
  });

  it("resumes from durable sequence after reopen and reports retention gaps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-events-"));
    roots.push(root);
    const clock = mutableClock("2026-08-01T00:00:00.000Z");
    let database = openVidcomDatabase(root);
    await migrateDatabase(database);
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    projectId, "/workspace", "watch", clock.now().toISOString(), clock.now().toISOString());
    let outbox = new SqliteEventOutbox(database, clock);
    const first = await outbox.append({ type: "job.progress", projectId, payload: { progress: 0.5 } });
    await outbox.append({ type: "job.progress", projectId, payload: { progress: 0.75 } });
    await database.destroy();

    database = openVidcomDatabase(root);
    outbox = new SqliteEventOutbox(database, clock);
    const reopened = await outbox.readFrom(0, 10);
    expect(reopened.gap).toBe(false);
    expect(reopened.events.map((event) => event.seq)).toEqual([first, first + 1]);
    clock.advance(24 * 60 * 60 * 1_000 + 1);
    const latest = await outbox.append({ type: "job.done", projectId, payload: { status: "succeeded" } });
    expect(await outbox.readFrom(first, 10)).toMatchObject({ gap: true, events: [{ seq: latest }] });
    expect(await outbox.latestSeq()).toBe(latest);
    await database.destroy();
  });

  it("uses an event-invalidated LRU and removes rejected promises", async () => {
    const cache = new ProjectCache(2);
    const model = (id: ProjectId) => ({ project: { id }, scenes: [], rootTrack: null, diagnostics: [] }) as unknown as CompositionModel;
    const ids = ["project_a", "project_b", "project_c"].map((id) => id as ProjectId);
    let loads = 0;
    expect(await cache.get(ids[0]!, async () => { loads += 1; return model(ids[0]!); })).toBe(
      await cache.get(ids[0]!, async () => { loads += 1; return model(ids[0]!); }),
    );
    expect(loads).toBe(1);
    await cache.get(ids[1]!, async () => model(ids[1]!));
    await cache.get(ids[2]!, async () => model(ids[2]!));
    expect(cache.size).toBe(2);
    cache.handleEvent({ type: "file.changed", projectId: ids[1]!, payload: {} });
    expect(cache.size).toBe(1);
    await expect(cache.get(ids[0]!, async () => { throw new Error("parse failed"); })).rejects.toThrow("parse failed");
    expect(cache.size).toBe(1);
  });

  it("debounces real external edits, advances entity revision, and suppresses own-write duplicates", async () => {
    expect(WATCH_DEBOUNCE_MS).toBe(150);
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-watcher-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "watch");
    const settingsPath = path.join(projectRoot, "preview-settings.json");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`);
    await writeFile(path.join(projectRoot, "index.html"), '<main data-composition-id="root"></main>');
    const initial = `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS)}\n`;
    await writeFile(settingsPath, initial);

    const clock = mutableClock("2026-08-01T00:00:00.000Z");
    const database = openVidcomDatabase(path.join(root, "app-data"));
    await migrateDatabase(database);
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    projectId, workspaceRoot, "watch", clock.now().toISOString(), clock.now().toISOString());
    dbRun(database, `INSERT INTO entity_state
      (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, projectId, "preview-settings", 1, hash(initial),
    "preview-settings.json", "system", clock.now().toISOString());
    dbRun(database, `INSERT INTO workspace_lease
      (workspace_root, lease_id, holder_id, acquired_at, expires_at)
      VALUES (?, 'lease_test', 'watcher-test', ?, '2026-08-01T01:00:00.000Z')`,
    workspaceRoot, clock.now().toISOString());
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const outbox = new SqliteEventOutbox(database, clock);
    const cache = new ProjectCache();
    const tracker = new WrittenHashTracker();
    const watcher = new WorkspaceWatcher(workspace, database, outbox, cache, tracker, clock);
    const ref = (await workspace.listProjects())[0]!;
    await cache.get(projectId, async () => ({ project: { id: projectId }, scenes: [], rootTrack: null, diagnostics: [] }) as unknown as CompositionModel);
    await watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const external = `${JSON.stringify({ ...DEFAULT_PREVIEW_SETTINGS, bgm: { ...DEFAULT_PREVIEW_SETTINGS.bgm, loop: false } })}\n`;
      await writeFile(settingsPath, external);
      await eventually(async () => dbOne<{ revision: number }>(database,
        "SELECT revision FROM entity_state WHERE project_id = ?", projectId)?.revision === 2);
      expect(cache.size).toBe(0);
      expect(await outbox.readFrom(0, 10)).toMatchObject({
        events: [{ type: "file.changed", payload: { path: "preview-settings.json", source: "external" } }],
      });

      const journal = new MutationJournal(database, clock);
      const authority = new WriteAuthority({
        workspace, journal, compositeJournal: journal,
        lease: new WorkspaceLease(database, clock, { newId: () => "unused" }),
        leaseId: "lease_test",
        hashContent: hash,
        invalidate(id) { cache.invalidate(id); },
        recordWrittenHash(id, relativePath, contentHash) { tracker.record(id, relativePath, contentHash); },
        notifyEvents() {},
      });
      const stale = await authority.mutateSource({
        kind: "entity", ref, entity: "preview-settings", patch: { bgm: { loop: true } }, expectedRevision: 1,
      }, "user");
      expect(stale).toMatchObject({ ok: false, error: { code: "write_conflict" } });
      const written = await authority.mutateSource({
        kind: "entity", ref, entity: "preview-settings", patch: { bgm: { loop: true } }, expectedRevision: 2,
      }, "user");
      expect(written).toMatchObject({ ok: true, value: { revision: 3 } });
      await new Promise((resolve) => setTimeout(resolve, 350));
      const events = await outbox.readFrom(0, 10);
      expect(events.events).toHaveLength(2);
      expect(events.events.filter((event) => event.payload.source === "external")).toHaveLength(1);
    } finally {
      watcher.close();
      await database.destroy();
    }
  });
});
