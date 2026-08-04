import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  type BackupPort,
  type CompositeMutationJournalPort,
  DEFAULT_PREVIEW_SETTINGS,
  type DerivedMutationPath,
  type DerivedMutationRequest,
  type JobId,
  serializePreviewSettings,
  WriteAuthority,
  type AbsolutePath,
  type ClockPort,
  type ProjectRef,
  type SourceMutationRequest,
} from "@vidcom/core";
import {
  AppDataAssetStager,
  AppDataBackupStore,
  initializeDatabase,
  LargePreviousContentStore,
  MutationJournal,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";

import { createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne, dbRun } from "../support/database";

let root: string;
let projectRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let authority: WriteAuthority;
let ref: ProjectRef;
let workspace: WorkspaceFs;
let journal: MutationJournal;
let lease: WorkspaceLease;
let leaseId: string;
let backups: AppDataBackupStore;
let appDataRoot: string;

const now = "2026-08-02T00:00:00.000Z";
const clock: ClockPort = { now: () => new Date(now) };
const projectId = "project_composite_write" as ProjectId;
const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-composite-write-"));
  const workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
  await writeFile(path.join(projectRoot, "index.html"), "entry-old");
  await writeFile(path.join(projectRoot, "compositions/a.html"), "a-old");
  const preview = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
  await writeFile(path.join(projectRoot, "preview-settings.json"), preview);

  appDataRoot = path.join(root, "app-data");
  database = await initializeDatabase(appDataRoot);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, workspaceRoot, "project", now, now);
  dbRun(database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 0, ?, 'preview-settings.json', 'system', ?)`, projectId, hash(preview), now);

  ref = {
    id: projectId,
    slug: "project",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  journal = new MutationJournal(database, clock, new LargePreviousContentStore(appDataRoot));
  lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:composite");
  if (!acquired.ok) throw new Error("test lease was denied");
  leaseId = acquired.leaseId;
  backups = new AppDataBackupStore(
    path.join(root, "app-data"),
    database,
    clock,
    createSequentialIdPort(),
  );
  authority = createAuthority();
});

function createAuthority(overrides: {
  compositeJournal?: CompositeMutationJournalPort;
  backups?: BackupPort;
} = {}): WriteAuthority {
  return new WriteAuthority({
    workspace,
    journal,
    compositeJournal: overrides.compositeJournal ?? journal,
    lease,
    leaseId,
    hashContent: hash,
    invalidate() {},
    notifyEvents() {},
    stagedAssets: new AppDataAssetStager(appDataRoot),
    backups: overrides.backups ?? backups,
  });
}

function journalBarrier(
  phase: "before-t1" | "after-t1",
  action: () => Promise<void>,
): CompositeMutationJournalPort {
  return new Proxy(journal, {
    get(target, property) {
      if (property === "beginComposite") {
        return async (...args: Parameters<MutationJournal["beginComposite"]>) => {
          if (phase === "before-t1") await action();
          const id = await target.beginComposite(...args);
          if (phase === "after-t1") await action();
          return id;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("Composite WriteAuthority with real SQLite and filesystem", () => {
  it("does not expose caller-selectable purpose or source-revision flags", () => {
    expectTypeOf<SourceMutationRequest>().not.toHaveProperty("purpose");
    expectTypeOf<SourceMutationRequest>().not.toHaveProperty("advancesSource");
    expectTypeOf<DerivedMutationRequest>().not.toHaveProperty("purpose");
    expectTypeOf<DerivedMutationRequest>().not.toHaveProperty("advancesSource");
  });

  it("keeps state, context, snapshot, and render revisions out of source revision", async () => {
    await mkdir(path.join(projectRoot, ".vidcom/context"), { recursive: true });
    await mkdir(path.join(projectRoot, "snapshots"), { recursive: true });
    await mkdir(path.join(projectRoot, "renders"), { recursive: true });
    const result = await authority.mutateDerived({
      ref,
      writes: [
        { path: ".vidcom/state.json" as DerivedMutationPath, content: "state" },
        { path: ".vidcom/context/project.md" as DerivedMutationPath, content: "context" },
        { path: "snapshots/scene.png" as DerivedMutationPath, content: new Uint8Array([1, 2, 3]) },
        { path: "renders/video.mp4" as DerivedMutationPath, content: new Uint8Array([4, 5, 6]) },
      ],
      producedByJobId: null,
      computedAtSourceRevision: 0,
    }, "system");
    expect(result).toMatchObject({ ok: true, value: { projectRevision: 1 } });
    expect(await journal.latestSourceRevision(projectId)).toBeNull();
    expect(await journal.latestRevision(projectId)).toBe(1);
    expect(dbAll(database, "SELECT advances_source AS advancesSource FROM revision ORDER BY id"))
      .toEqual([{ advancesSource: 0 }]);
    expect(await readFile(path.join(projectRoot, "snapshots/scene.png"))).toEqual(Buffer.from([1, 2, 3]));
    expect(await readFile(path.join(projectRoot, "renders/video.mp4"))).toEqual(Buffer.from([4, 5, 6]));
  });

  it("rejects authored source through mutateDerived without falling back", async () => {
    const result = await authority.mutateDerived({
      ref,
      writes: [{ path: "index.html" as DerivedMutationPath, content: "forbidden" }],
      producedByJobId: null,
      computedAtSourceRevision: 0,
    }, "system");
    expect(result).toMatchObject({ ok: false, error: { code: "asset_not_allowed" } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("entry-old");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
  });

  it("does not make a current snapshot stale when a render job publishes", async () => {
    await mkdir(path.join(projectRoot, "snapshots"), { recursive: true });
    await mkdir(path.join(projectRoot, "renders"), { recursive: true });
    const source = await authority.mutateSource({
      kind: "file",
      ref,
      path: "index.html" as RelPath,
      content: "entry-new",
      expectedContentHash: hash("entry-old"),
    }, "user");
    expect(source).toMatchObject({ ok: true, value: { revision: 1 } });

    const snapshot = await authority.mutateDerived({
      ref,
      writes: [{ path: "snapshots/current.png" as DerivedMutationPath, content: new Uint8Array([1]) }],
      producedByJobId: "job_snapshot" as JobId,
      computedAtSourceRevision: 1,
    }, "system");
    expect(snapshot).toMatchObject({ ok: true });
    const render = await authority.mutateDerived({
      ref,
      writes: [{ path: "renders/current.mp4" as DerivedMutationPath, content: new Uint8Array([2]) }],
      producedByJobId: "job_render" as JobId,
      computedAtSourceRevision: 1,
    }, "system");
    expect(render).toMatchObject({ ok: true });

    expect(await journal.latestSourceRevision(projectId)).toBe(1);
    expect(dbAll<{ summary: string }>(database, `SELECT summary FROM revision
      WHERE advances_source = 0 ORDER BY id`)
      .map(({ summary }) => JSON.parse(summary).computedAtSourceRevision)).toEqual([1, 1]);
  });

  it("retains three derived rollback generations, keeps revision rows, and reports pruned payload", async () => {
    await mkdir(path.join(projectRoot, ".vidcom"), { recursive: true });
    const target = path.join(projectRoot, ".vidcom/state.json");
    const large = (generation: number) => new Uint8Array(70 * 1024).fill(generation);
    await writeFile(target, large(0));
    for (let generation = 1; generation <= 4; generation += 1) {
      const result = await authority.mutateDerived({
        ref,
        writes: [{ path: ".vidcom/state.json" as DerivedMutationPath, content: large(generation) }],
        producedByJobId: null,
        computedAtSourceRevision: 0,
      }, "system");
      expect(result).toMatchObject({ ok: true });
    }
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 4 });
    expect(dbOne(database, `SELECT previous_content AS previousContent FROM revision_step
      WHERE revision_id = 1 AND path = '.vidcom/state.json'`)).toEqual({ previousContent: null });
    expect(await journal.readRevisionRollbackPayload(1, ".vidcom/state.json" as RelPath)).toMatchObject({
      ok: false, error: { code: "rollback_payload_pruned" },
    });
    expect(await journal.readRevisionRollbackPayload(2, ".vidcom/state.json" as RelPath))
      .toMatchObject({ ok: true });
    const objectRoot = path.join(appDataRoot, "objects", "previous-content", "sha256");
    const prefixes = await readdir(objectRoot, { withFileTypes: true });
    const objectFiles = (await Promise.all(prefixes.filter((entry) => entry.isDirectory()).map(
      (entry) => readdir(path.join(objectRoot, entry.name)),
    ))).flat();
    expect(objectFiles).toHaveLength(3);
  });

  it("uses idx_revision_source for latestSourceRevision", async () => {
    dbRun(database, `INSERT INTO revision
      (project_id, kind, path, content_hash, actor, advances_source, created_at)
      VALUES (?, 'file', 'index.html', ?, 'user', 1, ?)`, projectId, hash("source"), now);
    expect(await journal.latestSourceRevision(projectId)).toBe(1);
    const plan = dbAll<{ detail: string }>(database, `EXPLAIN QUERY PLAN
      SELECT id FROM revision
      WHERE project_id = ? AND advances_source = 1 ORDER BY id DESC LIMIT 1`, projectId);
    expect(plan.some(({ detail }) => detail.includes("idx_revision_source"))).toBe(true);
  });

  it("commits ordered multi-file steps as one composite revision", async () => {
    const result = await authority.mutateSource({
      ref,
      steps: [
        { kind: "write", path: "index.html" as RelPath, content: "entry-new", expectedContentHash: hash("entry-old") },
        { kind: "write", path: "compositions/a.html" as RelPath, content: "a-new", expectedContentHash: hash("a-old") },
      ],
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(result).toMatchObject({ ok: true, value: { projectRevision: 1, entityRevision: null } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("entry-new");
    expect(await readFile(path.join(projectRoot, "compositions/a.html"), "utf8")).toBe("a-new");
    expect(dbOne(database, "SELECT kind FROM revision WHERE id = 1")).toEqual({ kind: "composite" });
    expect(dbAll(database, "SELECT ordinal, path FROM revision_step ORDER BY ordinal")).toEqual([
      { ordinal: 0, path: "index.html" },
      { ordinal: 1, path: "compositions/a.html" },
    ]);
  });

  it("commits file and entity steps together with one project revision", async () => {
    const result = await authority.mutateSource({
      ref,
      steps: [
        { kind: "write", path: "index.html" as RelPath, content: "entry-new", expectedContentHash: hash("entry-old") },
        { kind: "entity", entity: "preview-settings", patch: { bgm: { volume: 0.7 } }, expectedRevision: 0 },
      ],
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(result).toMatchObject({ ok: true, value: { projectRevision: 1, entityRevision: 1 } });
    expect(dbOne(database, `SELECT revision FROM entity_state
      WHERE project_id = ? AND entity = 'preview-settings'`, projectId)).toEqual({ revision: 1 });
    expect(dbAll(database, "SELECT ordinal, kind FROM revision_step ORDER BY ordinal")).toEqual([
      { ordinal: 0, kind: "write" },
      { ordinal: 1, kind: "entity" },
    ]);
  });

  it("serializes a shared precondition race so one request wins and one never touches disk", async () => {
    const mutate = (content: string) => authority.mutateSource({
      ref,
      steps: [{ kind: "write", path: "index.html" as RelPath, content, expectedContentHash: hash("entry-old") }],
      toolAudit: null,
      backup: false,
    }, "agent");
    const results = await Promise.all([mutate("winner-a"), mutate("winner-b")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: "write_conflict" } });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
    expect(["winner-a", "winner-b"]).toContain(await readFile(path.join(projectRoot, "index.html"), "utf8"));
  });

  it.each(["before-t1", "after-t1"] as const)(
    "preserves an external edit injected %s and aborts without a revision",
    async (phase) => {
      const target = path.join(projectRoot, "index.html");
      authority = createAuthority({
        compositeJournal: journalBarrier(phase, () => writeFile(target, "external-edit")),
      });

      const result = await authority.mutateSource({
        ref,
        steps: [{
          kind: "write",
          path: "index.html" as RelPath,
          content: "daemon-write",
          expectedContentHash: hash("entry-old"),
        }],
        toolAudit: null,
        backup: false,
      }, "agent");

      expect(result).toMatchObject({ ok: false, error: { code: "write_conflict" } });
      expect(await readFile(target, "utf8")).toBe("external-edit");
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
      expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "aborted" });
    },
  );

  it.each(["during-backup", "after-backup-verify"] as const)(
    "backs up captured bytes, preserves an external edit %s, and never commits the delete",
    async (phase) => {
      const target = path.join(projectRoot, "compositions/a.html");
      const barrierBackups: BackupPort = new Proxy(backups, {
        get(store, property) {
          if (property === "create") {
            return async (...args: Parameters<AppDataBackupStore["create"]>) => {
              if (phase === "during-backup") await writeFile(target, "external-edit");
              return store.create(...args);
            };
          }
          if (property === "verify") {
            return async (...args: Parameters<AppDataBackupStore["verify"]>) => {
              const valid = await store.verify(...args);
              if (phase === "after-backup-verify") await writeFile(target, "external-edit");
              return valid;
            };
          }
          const value = Reflect.get(store, property, store) as unknown;
          return typeof value === "function" ? value.bind(store) : value;
        },
      });
      authority = createAuthority({ backups: barrierBackups });

      const result = await authority.mutateSource({
        ref,
        steps: [{
          kind: "delete",
          path: "compositions/a.html" as RelPath,
          expectedContentHash: hash("a-old"),
        }],
        toolAudit: null,
        backup: true,
      }, "agent");

      expect(result).toMatchObject({ ok: false, error: { code: "write_conflict" } });
      expect(await readFile(target, "utf8")).toBe("external-edit");
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
      const manifest = (await backups.list(projectId))[0];
      expect(manifest).toBeDefined();
      await expect(backups.readPayloads(manifest!.id)).resolves.toMatchObject([
        { path: "compositions/a.html", contentHash: hash("a-old") },
      ]);
    },
  );

  it("keeps landed bytes and gates the next write when T2 cannot commit", async () => {
    dbRun(database, `CREATE TRIGGER fail_composite_commit
      BEFORE INSERT ON revision_step
      BEGIN SELECT RAISE(ABORT, 'injected T2 failure'); END`);

    const failedCommit = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "landed-before-t2",
        expectedContentHash: hash("entry-old"),
      }],
      toolAudit: null,
      backup: false,
    }, "agent");

    expect(failedCommit).toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("landed-before-t2");
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "pending" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });

    dbRun(database, "DROP TRIGGER fail_composite_commit");
    const gated = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "must-not-land",
        expectedContentHash: hash("landed-before-t2"),
      }],
      toolAudit: null,
      backup: false,
    }, "agent");

    expect(gated).toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("landed-before-t2");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
  });
});
