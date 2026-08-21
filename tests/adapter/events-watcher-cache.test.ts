import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
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
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  ProjectCache,
  ProjectPathInvalidatorFanout,
  WriteAuthority,
  type AbsolutePath,
  type CompositionModel,
  type JournalId,
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
  it("waits for tracker settlement and compares file, directory, and absent terminal state", async () => {
    const tracker = new WrittenHashTracker();
    const journalId = 7 as JournalId;
    const filePath = "assets/item.txt" as RelPath;
    tracker.arm(projectId, journalId, [{
      path: filePath,
      before: { kind: "absent" },
      after: { kind: "file", contentHash: hash("item") },
    }]);
    let sampled = 0;
    const pending = tracker.sample(projectId, filePath, async () => {
      sampled += 1;
      return { kind: "file" as const, contentHash: hash("item") };
    });
    expect(sampled).toBe(0);
    tracker.settle(journalId, "committed");
    await expect(pending).resolves.toEqual({
      ownWrite: true,
      state: { kind: "file", contentHash: hash("item") },
    });
    expect(sampled).toBe(1);

    const directoryPath = "assets/new" as RelPath;
    tracker.arm(projectId, 8 as JournalId, [{
      path: directoryPath,
      before: { kind: "absent" },
      after: { kind: "directory" },
    }]);
    tracker.settle(8 as JournalId, "rolled_back");
    await expect(tracker.sample(projectId, directoryPath, async () => ({ kind: "directory" as const })))
      .resolves.toMatchObject({ ownWrite: false, state: { kind: "directory" } });

    const rolledBackPath = "assets/rolled-back.txt" as RelPath;
    tracker.arm(projectId, 81 as JournalId, [{
      path: rolledBackPath,
      before: { kind: "file", contentHash: hash("before") },
      after: { kind: "file", contentHash: hash("after") },
    }]);
    tracker.settle(81 as JournalId, "rolled_back");
    await expect(tracker.sample(projectId, rolledBackPath, async () => ({
      kind: "file" as const,
      contentHash: hash("before"),
    }))).resolves.toMatchObject({ ownWrite: true });

    const unknownPath = "assets/unknown.txt" as RelPath;
    tracker.arm(projectId, 82 as JournalId, [{
      path: unknownPath,
      before: { kind: "absent" },
      after: { kind: "file", contentHash: hash("after") },
    }]);
    tracker.settle(82 as JournalId, "unknown");
    await expect(tracker.sample(projectId, unknownPath, async () => ({
      kind: "file" as const,
      contentHash: hash("after"),
    }))).resolves.toMatchObject({ ownWrite: false });

    const mismatchPath = "assets/mismatch.txt" as RelPath;
    tracker.arm(projectId, 83 as JournalId, [{
      path: mismatchPath,
      before: { kind: "absent" },
      after: { kind: "file", contentHash: hash("expected") },
    }]);
    tracker.settle(83 as JournalId, "committed");
    await expect(tracker.sample(projectId, mismatchPath, async () => ({
      kind: "file" as const,
      contentHash: hash("external"),
    }))).resolves.toMatchObject({ ownWrite: false });

    const changingPath = "assets/changing.txt" as RelPath;
    tracker.arm(projectId, 9 as JournalId, [{
      path: changingPath,
      before: { kind: "absent" },
      after: { kind: "file", contentHash: hash("first") },
    }]);
    let reads = 0;
    const changing = tracker.sample(projectId, changingPath, async () => {
      reads += 1;
      if (reads === 1) {
        tracker.arm(projectId, 10 as JournalId, [{
          path: changingPath,
          before: { kind: "file", contentHash: hash("first") },
          after: { kind: "file", contentHash: hash("second") },
        }]);
        tracker.settle(10 as JournalId, "committed");
      }
      return { kind: "file" as const, contentHash: hash("second") };
    });
    tracker.settle(9 as JournalId, "committed");
    await expect(changing).resolves.toMatchObject({ ownWrite: true });
    expect(reads).toBe(2);
  });

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
    const otherProjectId = "project_watch_other" as ProjectId;
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    otherProjectId, "/workspace-other", "watch-other", clock.now().toISOString(), clock.now().toISOString());
    expect(await outbox.latestProjectSeq(otherProjectId)).toBe(0);
    const otherSeq = await outbox.append({ type: "job.done", projectId: otherProjectId, payload: {} });
    const reopened = await outbox.readFrom(0, 10);
    expect(reopened.gap).toBe(false);
    expect(reopened.events.map((event) => event.seq)).toEqual([first, first + 1, otherSeq]);
    expect(await outbox.latestProjectSeq(projectId)).toBe(first + 1);
    expect(await outbox.latestProjectSeq(otherProjectId)).toBe(otherSeq);
    clock.advance(24 * 60 * 60 * 1_000 + 1);
    const latest = await outbox.append({ type: "job.done", projectId, payload: { status: "succeeded" } });
    expect(await outbox.latestProjectSeq(projectId)).toBe(latest);
    expect(await outbox.readFrom(first, 10)).toMatchObject({ gap: true, events: [{ seq: latest }] });
    expect(await outbox.latestSeq()).toBe(latest);
    await database.destroy();
  });

  it("isolates path invalidator fanout failures and preserves exact paths", () => {
    const calls: Array<{ projectId: ProjectId; paths: readonly string[] }> = [];
    const errors: unknown[] = [];
    const paths = ["index.html" as RelPath, "compositions/main.html" as RelPath] as const;
    const invalidator = new ProjectPathInvalidatorFanout([
      { invalidate() { throw new Error("consumer failed"); } },
      { invalidate(id, receivedPaths) { calls.push({ projectId: id, paths: receivedPaths }); } },
    ], (error) => {
      errors.push(error);
      throw new Error("observability failed");
    });

    expect(() => invalidator.invalidate(projectId, paths)).not.toThrow();
    expect(calls).toEqual([{ projectId, paths }]);
    expect(errors).toHaveLength(1);
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
        writtenStates: tracker,
        recordWrittenHash(id, relativePath, contentHash) { tracker.record(id, relativePath, contentHash); },
        notifyEvents() {},
      });
      const stale = await authority.mutateSource({
        kind: "entity", ref, entity: "preview-settings", patch: { bgm: { loop: true } }, expectedRevision: 1,
      }, "user");
      expect(stale).toMatchObject({ ok: false, error: { code: "write_conflict" } });
      // The next authored write must advance the entity revision by exactly one.
      // The absolute number is not asserted, and the expectation is read from the
      // settled row: a platform whose recursive watcher reports one change more
      // than once (Windows does) can settle the same external content at a higher
      // revision, which is not what this case is about.
      const settled = dbOne<{ revision: number }>(database,
        "SELECT revision FROM entity_state WHERE project_id = ?", projectId)!.revision;
      expect(settled).toBeGreaterThanOrEqual(2);
      const written = await authority.mutateSource({
        kind: "entity", ref, entity: "preview-settings", patch: { bgm: { loop: true } }, expectedRevision: settled,
      }, "user");
      expect(written).toMatchObject({ ok: true, value: { revision: settled + 1 } });
      await new Promise((resolve) => setTimeout(resolve, 350));
      const events = await outbox.readFrom(0, 10);
      expect(events.events).toHaveLength(2);
      expect(events.events.filter((event) => event.payload.source === "external")).toHaveLength(1);
    } finally {
      watcher.close();
      await database.destroy();
    }
  });

  it("suppresses own file/directory terminal states and barriers only canonical external paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-watcher-states-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "watch");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), "<main></main>");
    const clock = mutableClock("2026-08-17T00:00:00.000Z");
    const database = openVidcomDatabase(path.join(root, "app-data"));
    await migrateDatabase(database);
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    projectId, workspaceRoot, "watch", clock.now().toISOString(), clock.now().toISOString());
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const outbox = new SqliteEventOutbox(database, clock);
    const tracker = new WrittenHashTracker();
    const invalidated: RelPath[][] = [];
    const external: RelPath[][] = [];
    const observer = {
      claimHistoryOperation: () => ({ ok: true as const }),
      abortHistoryOperation() {},
      blockHistoryOperation() {},
      emit: () => ({ ok: true as const }),
      observeExternalChange(_id: ProjectId, paths: RelPath[]) { external.push(paths); },
      invalidateProject() {},
    };
    const workspaceWithoutReadFile = new Proxy(workspace, {
      get(target, property, receiver) {
        if (property === "readFile") return () => { throw new Error("watcher must hash without readFile"); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const watcher = new WorkspaceWatcher(
      workspaceWithoutReadFile,
      database,
      outbox,
      { invalidate(_id, paths) { invalidated.push([...paths]); throw new Error("isolated invalidator"); } },
      tracker,
      clock,
      WATCH_DEBOUNCE_MS,
      undefined,
      observer,
    );
    const ref = (await workspace.listProjects())[0]!;
    const assets = "assets" as RelPath;
    const item = "assets/item.txt" as RelPath;

    tracker.arm(projectId, 20 as JournalId, [{ path: assets, before: { kind: "absent" }, after: { kind: "directory" } }]);
    await mkdir(path.join(projectRoot, assets));
    tracker.settle(20 as JournalId, "committed");
    await watcher.observe(ref, assets);
    tracker.arm(projectId, 21 as JournalId, [{
      path: item,
      before: { kind: "absent" },
      after: { kind: "file", contentHash: hash("item") },
    }]);
    await writeFile(path.join(projectRoot, item), "item");
    tracker.settle(21 as JournalId, "committed");
    await watcher.observe(ref, item);
    tracker.arm(projectId, 22 as JournalId, [{
      path: item,
      before: { kind: "file", contentHash: hash("item") },
      after: { kind: "absent" },
    }]);
    await rm(path.join(projectRoot, item));
    tracker.settle(22 as JournalId, "committed");
    await watcher.observe(ref, item);
    tracker.arm(projectId, 23 as JournalId, [{ path: assets, before: { kind: "directory" }, after: { kind: "absent" } }]);
    await rm(path.join(projectRoot, assets), { recursive: true });
    tracker.settle(23 as JournalId, "committed");
    await watcher.observe(ref, assets);
    expect((await outbox.readFrom(0, 20)).events).toEqual([]);
    expect(external).toEqual([]);

    const externalDirectory = "external" as RelPath;
    await mkdir(path.join(projectRoot, externalDirectory));
    const externalResolved = await workspace.resolve(ref, externalDirectory, "authored-write");
    expect(externalResolved).toMatchObject({ ok: true });
    if (!externalResolved.ok) throw new Error("external directory did not resolve");
    expect(path.basename(externalResolved.value)).toBe(externalDirectory);
    await watcher.observe(ref, externalDirectory);
    await rm(path.join(projectRoot, externalDirectory), { recursive: true });
    await watcher.observe(ref, externalDirectory);

    const externalFile = "external.txt" as RelPath;
    await writeFile(path.join(projectRoot, externalFile), "external-file");
    await watcher.observe(ref, externalFile);
    await rm(path.join(projectRoot, externalFile));
    await watcher.observe(ref, externalFile);

    const parentA = "assets/a" as RelPath;
    const renamedA = "assets/a-renamed" as RelPath;
    const siblingAb = "assets/ab" as RelPath;
    await mkdir(path.join(projectRoot, parentA), { recursive: true });
    await mkdir(path.join(projectRoot, siblingAb), { recursive: true });
    await writeFile(path.join(projectRoot, parentA, "guard.txt"), "guard");
    await writeFile(path.join(projectRoot, siblingAb, "other.txt"), "other");
    await rename(path.join(projectRoot, parentA), path.join(projectRoot, renamedA));
    await watcher.observe(ref, parentA);
    await watcher.observe(ref, renamedA);

    await watcher.observe(ref, "../outside.txt" as RelPath);
    await watcher.observe(ref, path.join(root, "outside.txt") as RelPath);
    await watcher.observe(ref, "bad\0path" as RelPath);
    await writeFile(path.join(root, "outside.txt"), "outside");
    try {
      await symlink(path.join(root, "outside.txt"), path.join(projectRoot, "escape.txt"));
      await watcher.observe(ref, "escape.txt" as RelPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    expect((await outbox.readFrom(0, 20)).events.map((event) => event.payload)).toEqual([
      { path: "external", source: "external" },
      { path: "external", source: "external" },
      { path: "external.txt", source: "external" },
      { path: "external.txt", source: "external" },
      { path: "assets/a", source: "external" },
      { path: "assets/a-renamed", source: "external" },
    ]);
    expect(invalidated).toEqual([
      [externalDirectory], [externalDirectory],
      [externalFile], [externalFile],
      [parentA], [renamedA],
    ]);
    expect(external).toEqual([
      [externalDirectory], [externalDirectory],
      [externalFile], [externalFile],
      [parentA], [renamedA],
    ]);
    expect(invalidated.flat()).not.toContain(siblingAb);
    expect(external.flat()).not.toContain(siblingAb);
    await database.destroy();
  });
});
