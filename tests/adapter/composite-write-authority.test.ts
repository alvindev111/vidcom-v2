import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  type BackupPort,
  type CompositeStep,
  type CompositeMutationJournalPort,
  DEFAULT_PREVIEW_SETTINGS,
  type DerivedMutationPath,
  type DerivedMutationRequest,
  type JobId,
  type JournalId,
  type MutationObserverPort,
  type MutationReceipt,
  type PendingMountPort,
  ProjectCache,
  ProjectPathInvalidatorFanout,
  reconcileCompositeMutation,
  serializePreviewSettings,
  type ProjectPathInvalidator,
  type UndoContentPort,
  WriteAuthority,
  type AbsolutePath,
  type ClockPort,
  type ProjectRef,
  type SourceMutationRequest,
  type WorkspacePort,
} from "@vidcom/core";
import {
  AppDataAssetStager,
  AppDataBackupStore,
  initializeDatabase,
  LargePreviousContentStore,
  MutationJournal,
  SqlitePendingMountStore,
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
let largeContent: LargePreviousContentStore;

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
const RECORD_ORIGIN = {
  kind: "ui",
  sessionId: "01K2TESTSESSION000000000000",
  label: "Edit project",
  historyAction: "record",
  historyOperation: null,
} as const;
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
  largeContent = new LargePreviousContentStore(appDataRoot);
  journal = new MutationJournal(database, clock, largeContent);
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
  workspace?: WorkspacePort;
  observer?: MutationObserverPort;
  undoContent?: UndoContentPort;
  pathInvalidator?: ProjectPathInvalidator;
  pendingMount?: PendingMountPort;
} = {}): WriteAuthority {
  return new WriteAuthority({
    workspace: overrides.workspace ?? workspace,
    journal,
    compositeJournal: overrides.compositeJournal ?? journal,
    lease,
    leaseId,
    hashContent: hash,
    invalidate() {},
    pathInvalidator: overrides.pathInvalidator,
    pendingMount: overrides.pendingMount,
    notifyEvents() {},
    stagedAssets: new AppDataAssetStager(appDataRoot),
    backups: overrides.backups ?? backups,
    observer: overrides.observer,
    undoContent: overrides.undoContent,
    clock,
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
  it("keeps a committed mutation and ordered invalidation fanout when one consumer throws", async () => {
    const cache = new ProjectCache();
    await cache.get(projectId, async () => ({ project: { id: projectId }, scenes: [], rootTrack: null, diagnostics: [] }) as never);
    const later: RelPath[][] = [];
    const diagnostics: unknown[] = [];
    const pathInvalidator = new ProjectPathInvalidatorFanout([
      cache,
      { invalidate() { throw new Error("injected invalidator failure"); } },
      { invalidate(_id, paths) { later.push([...paths]); } },
    ], (error) => { diagnostics.push(error); });
    authority = createAuthority({ pathInvalidator });

    await expect(authority.mutateSource({
      ref,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "entry-new", expectedContentHash: hash("entry-old") }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: true, value: { projectRevision: 1 } });

    expect(cache.size).toBe(0);
    expect(later).toEqual([["index.html"]]);
    expect(diagnostics).toHaveLength(1);
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("entry-new");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM event_outbox")).toEqual({ count: 1 });
  });

  it("resolves both object receipt refs after capture discard", async () => {
    const receipts: MutationReceipt[] = [];
    const observer: MutationObserverPort = {
      claimHistoryOperation: () => ({ ok: true }),
      abortHistoryOperation() {},
      blockHistoryOperation() {},
      emit(receipt) { receipts.push(receipt); return { ok: true }; },
      observeExternalChange() {},
      invalidateProject() {},
    };
    const oldContent = "old-".padEnd(2 * 1024 * 1024, "o");
    const newContent = "new-".padEnd(2 * 1024 * 1024, "n");
    await writeFile(path.join(projectRoot, "index.html"), oldContent);
    authority = createAuthority({ observer, undoContent: largeContent });

    await expect(authority.mutateSource({
      ref,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: newContent, expectedContentHash: hash(oldContent) }],
      origin: RECORD_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({ ok: true });

    const step = receipts[0]?.steps[0];
    expect(step).toMatchObject({ kind: "file", undoable: true });
    if (!step || step.kind !== "file" || !step.undoable) throw new Error("undoable file receipt was not emitted");
    for (const [contentRef, expected] of [[step.beforeContent, oldContent], [step.afterContent, newContent]] as const) {
      expect(contentRef).toMatchObject({ kind: "object", contentHash: hash(expected) });
      if (!contentRef) throw new Error("receipt content ref was absent");
      const resolved = await largeContent.resolve(contentRef);
      expect(resolved).not.toBeInstanceOf(Uint8Array);
      if (resolved instanceof Uint8Array) throw new Error("large receipt content unexpectedly resolved inline");
      expect(await readFile(resolved.sourcePath, "utf8")).toBe(expected);
    }
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(newContent);
  });

  it.each(["throw", "reject"] as const)(
    "keeps the committed mutation and releases receipt leases when observer emit %s",
    async (mode) => {
      let invalidations = 0;
      const observer: MutationObserverPort = {
        claimHistoryOperation: () => ({ ok: true }),
        abortHistoryOperation() {},
        blockHistoryOperation() {},
        emit() {
          if (mode === "throw") throw new Error("injected observer failure");
          return { ok: false, reason: "injected observer rejection" };
        },
        observeExternalChange() {},
        invalidateProject() { invalidations += 1; },
      };
      const oldContent = `${mode}-old-`.padEnd(2 * 1024 * 1024, "o");
      const newContent = `${mode}-new-`.padEnd(2 * 1024 * 1024, "n");
      await writeFile(path.join(projectRoot, "index.html"), oldContent);
      authority = createAuthority({ observer, undoContent: largeContent });

      await expect(authority.mutateSource({
        ref,
        steps: [{ kind: "write", path: "index.html" as RelPath, content: newContent, expectedContentHash: hash(oldContent) }],
        origin: RECORD_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "user")).resolves.toMatchObject({
        ok: true,
        value: { diagnostics: [{ severity: "warning", code: "history-unavailable" }] },
      });
      expect(invalidations).toBe(1);
      expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(newContent);

      const durable = new Set(dbAll<{ hash: string }>(database, `
        SELECT previous_object_hash AS hash FROM mutation_step WHERE previous_object_hash IS NOT NULL
      `).map(({ hash: value }) => value));
      expect(await largeContent.cleanupUnreferenced(durable, new Date("2100-01-01"))).toBe(1);
      await expect(largeContent.open(hash(oldContent))).resolves.toMatchObject({ contentHash: hash(oldContent) });
      await expect(largeContent.open(hash(newContent))).rejects.toBeDefined();
    },
  );

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

  it("publishes an authored staged source without exposing bytes to the composite request", async () => {
    await mkdir(path.join(projectRoot, "assets"));
    const sourcePath = path.join(appDataRoot, "staged-upload.bin");
    const bytes = new Uint8Array([0, 1, 2, 3, 255]);
    await writeFile(sourcePath, bytes);

    const result = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write-staged",
        path: "assets/upload.bin" as RelPath,
        source: { sourcePath: sourcePath as AbsolutePath, contentHash: hash(bytes) },
        expectedContentHash: null,
        undoable: false,
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user");

    expect(result).toMatchObject({ ok: true, value: { fileHashes: { "assets/upload.bin": hash(bytes) } } });
    expect(await readFile(path.join(projectRoot, "assets/upload.bin"))).toEqual(Buffer.from(bytes));

    const replacement = new Uint8Array([9, 8, 7, 6]);
    const replacementPath = path.join(appDataRoot, "staged-replacement.bin");
    await writeFile(replacementPath, replacement);
    const replaced = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write-staged",
        path: "assets/upload.bin" as RelPath,
        source: { sourcePath: replacementPath as AbsolutePath, contentHash: hash(replacement) },
        expectedContentHash: hash(bytes),
        undoable: true,
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user");
    expect(replaced.ok, replaced.ok ? "" : JSON.stringify(replaced.error)).toBe(true);
    if (!replaced.ok) return;
    expect(replaced).toMatchObject({ ok: true, value: { fileHashes: { "assets/upload.bin": hash(replacement) } } });
    expect(await readFile(path.join(projectRoot, "assets/upload.bin"))).toEqual(Buffer.from(replacement));
  });

  it("requires an existing or journaled parent for authored staged writes", async () => {
    const sourcePath = path.join(appDataRoot, "staged-parent.bin");
    await writeFile(sourcePath, "parent");
    const source = { sourcePath: sourcePath as AbsolutePath, contentHash: hash("parent") };
    const request = (steps: CompositeStep[]) => authority.mutateSource({
      ref,
      steps,
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user");

    await expect(request([{
      kind: "write-staged",
      path: "assets/new-parent/item.bin" as RelPath,
      source,
      expectedContentHash: null,
      undoable: false,
    }])).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });

    await expect(request([
      { kind: "mkdir", path: "assets" as RelPath, expectExisting: "absent" },
      { kind: "mkdir", path: "assets/new-parent" as RelPath, expectExisting: "absent" },
      {
        kind: "write-staged",
        path: "assets/new-parent/item.bin" as RelPath,
        source,
        expectedContentHash: null,
        undoable: false,
      },
    ])).resolves.toMatchObject({ ok: true });
    expect(await readFile(path.join(projectRoot, "assets/new-parent/item.bin"), "utf8")).toBe("parent");
  });

  it("reconciles a staged pending-mount open after publish without rewriting or changing its receipt id", async () => {
    await mkdir(path.join(projectRoot, "assets"));
    const sourcePath = path.join(appDataRoot, "pending-upload.bin") as AbsolutePath;
    const targetPath = path.join(projectRoot, "assets/pending.bin");
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const operationId = "01K00000000000000000000000";
    await writeFile(sourcePath, bytes);
    const pendingMount = new SqlitePendingMountStore(database, clock);
    authority = createAuthority({ pendingMount });
    dbRun(database, `CREATE TRIGGER fail_pending_mount_t2 BEFORE INSERT ON revision
      BEGIN SELECT RAISE(ABORT, 'injected post-publish crash'); END`);

    await expect(authority.mutateSource({
      ref,
      steps: [{
        kind: "write-staged",
        path: "assets/pending.bin" as RelPath,
        source: { sourcePath, contentHash: hash(bytes) },
        expectedContentHash: null,
        undoable: false,
      }],
      origin: TEST_ORIGIN,
      pendingMountTransition: {
        kind: "open",
        operationId,
        record: {
          operationId,
          projectId,
          assetPath: "assets/pending.bin" as RelPath,
          assetContentHash: hash(bytes),
          uploadFingerprint: hash("pending-upload-fingerprint"),
          atSeconds: 1.25,
          trackIndex: 2,
        },
      },
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.RecoveryRequired } });
    expect(await readFile(targetPath)).toEqual(Buffer.from(bytes));
    const landedMtime = (await stat(targetPath)).mtimeMs;
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "pending" });

    dbRun(database, "DROP TRIGGER fail_pending_mount_t2");
    const receipts: MutationReceipt[] = [];
    const observer: MutationObserverPort = {
      claimHistoryOperation: () => ({ ok: true }),
      abortHistoryOperation() {},
      blockHistoryOperation() {},
      emit(receipt) { receipts.push(receipt); return { ok: true }; },
      observeExternalChange() {},
      invalidateProject() {},
    };
    await expect(reconcileCompositeMutation({
      workspace,
      journal,
      observer,
      clock,
      async resolveProjectRef() { return ref; },
    }, 1 as JournalId)).resolves.toMatchObject({ ok: true, value: { terminal: "committed" } });

    expect((await stat(targetPath)).mtimeMs).toBe(landedMtime);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
    expect(receipts).toMatchObject([{
      id: "journal:1",
      origin: { kind: "system", historyAction: "ignore" },
      paths: ["assets/pending.bin"],
    }]);
    await expect(pendingMount.lookup(projectId, operationId)).resolves.toMatchObject({
      state: "active",
      record: {
        state: "uploaded_unmounted",
        lastFailure: null,
        mountedSceneId: null,
        mountedRevision: null,
      },
    });
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
    const uiOrigin = {
      kind: "ui",
      sessionId: "session-secret",
      label: "private label",
      historyAction: "record",
      historyOperation: null,
    } as const;
    const result = await authority.mutateSource({
      ref,
      steps: [
        { kind: "write", path: "index.html" as RelPath, content: "entry-new", expectedContentHash: hash("entry-old") },
        { kind: "write", path: "compositions/a.html" as RelPath, content: "a-new", expectedContentHash: hash("a-old") },
      ],
      origin: uiOrigin,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(result).toMatchObject({ ok: true, value: { projectRevision: 1, entityRevision: null, changeSeq: 1 } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("entry-new");
    expect(await readFile(path.join(projectRoot, "compositions/a.html"), "utf8")).toBe("a-new");
    expect(dbOne(database, "SELECT kind FROM revision WHERE id = 1")).toEqual({ kind: "composite" });
    expect(dbAll(database, "SELECT ordinal, path FROM revision_step ORDER BY ordinal")).toEqual([
      { ordinal: 0, path: "index.html" },
      { ordinal: 1, path: "compositions/a.html" },
    ]);
    expect(dbOne(database, "SELECT seq, payload FROM event_outbox")).toEqual({
      seq: 1,
      payload: JSON.stringify({
        composite: true,
        paths: ["index.html", "compositions/a.html"],
        source: "ui",
      }),
    });
    const unchanged = await authority.mutateSource({
      ref,
      steps: [
        { kind: "write", path: "index.html" as RelPath, content: "entry-new", expectedContentHash: hash("entry-new") },
        { kind: "write", path: "compositions/a.html" as RelPath, content: "a-new", expectedContentHash: hash("a-new") },
      ],
      origin: uiOrigin,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(unchanged).toMatchObject({ ok: true, value: { changeSeq: null } });
    expect(dbAll(database, "SELECT seq FROM event_outbox")).toEqual([{ seq: 1 }]);
  });

  it("commits file and entity steps together with one project revision", async () => {
    const result = await authority.mutateSource({
      ref,
      steps: [
        { kind: "write", path: "index.html" as RelPath, content: "entry-new", expectedContentHash: hash("entry-old") },
        { kind: "entity", entity: "preview-settings", patch: { bgm: { volume: 0.7 } }, expectedRevision: 0 },
      ],
      origin: TEST_ORIGIN,
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

  it("publishes and journals ordered mkdir/write/rmdir steps", async () => {
    const created = await authority.mutateSource({
      ref,
      steps: [
        { kind: "mkdir", path: "assets" as RelPath, expectExisting: "absent" },
        { kind: "mkdir", path: "assets/new" as RelPath, expectExisting: "absent" },
        { kind: "mkdir", path: "assets/new/sub" as RelPath, expectExisting: "absent" },
        { kind: "write", path: "assets/new/sub/item.txt" as RelPath, content: "item", expectedContentHash: null },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(created).toMatchObject({ ok: true });
    expect(await readFile(path.join(projectRoot, "assets/new/sub/item.txt"), "utf8")).toBe("item");
    expect(dbAll(database, "SELECT ordinal, kind, path, existed_before AS existedBefore FROM mutation_step ORDER BY ordinal"))
      .toEqual([
        { ordinal: 0, kind: "mkdir", path: "assets", existedBefore: 0 },
        { ordinal: 1, kind: "mkdir", path: "assets/new", existedBefore: 0 },
        { ordinal: 2, kind: "mkdir", path: "assets/new/sub", existedBefore: 0 },
        { ordinal: 3, kind: "write", path: "assets/new/sub/item.txt", existedBefore: null },
      ]);

    const removed = await authority.mutateSource({
      ref,
      steps: [
        { kind: "delete", path: "assets/new/sub/item.txt" as RelPath, expectedContentHash: hash("item") },
        { kind: "rmdir", path: "assets/new/sub" as RelPath, expectEmpty: true },
        { kind: "rmdir", path: "assets/new" as RelPath, expectEmpty: true },
        { kind: "rmdir", path: "assets" as RelPath, expectEmpty: true },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(removed).toMatchObject({ ok: true });
    await expect(readFile(path.join(projectRoot, "assets/new/sub/item.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(projectRoot, "assets/new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips directory intent and existedBefore through the journal", async () => {
    const intent = {
      ordinal: 0,
      kind: "mkdir" as const,
      path: "assets" as RelPath,
      entity: null,
      fromHash: null,
      toHash: null,
      previousContent: null,
      existedBefore: false,
    };
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [intent],
      { toolAudit: null },
      { leaseId },
    );
    const envelope = await journal.commitComposite(id, {
      projectId,
      actor: "agent",
      steps: [{ ...intent, status: "written" }],
      event: { type: "project.changed", projectId, payload: { paths: ["assets"] } },
      diagnostics: [],
    });
    expect(envelope).toMatchObject({ projectRevision: 1 });
    expect(await journal.readSteps(id)).toEqual([intent]);
    expect(dbOne(database, "SELECT kind, existed_before AS existedBefore FROM revision_step")).toEqual({
      kind: "mkdir",
      existedBefore: 0,
    });
  });

  it("preserves external races instead of merging mkdir or deleting non-empty rmdir", async () => {
    const mkdirTarget = path.join(projectRoot, "race-created");
    const mkdirAuthority = createAuthority({
      compositeJournal: journalBarrier("after-t1", async () => { await mkdir(mkdirTarget); }),
    });
    await expect(mkdirAuthority.mutateSource({
      ref,
      steps: [{ kind: "mkdir", path: "race-created" as RelPath, expectExisting: "absent" }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(await readdir(mkdirTarget)).toEqual([]);

    const rmdirTarget = path.join(projectRoot, "race-removed");
    await mkdir(rmdirTarget);
    const rmdirAuthority = createAuthority({
      compositeJournal: journalBarrier("after-t1", async () => {
        await writeFile(path.join(rmdirTarget, "external.txt"), "external");
      }),
    });
    await expect(rmdirAuthority.mutateSource({
      ref,
      steps: [{ kind: "rmdir", path: "race-removed" as RelPath, expectEmpty: true }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(await readFile(path.join(rmdirTarget, "external.txt"), "utf8")).toBe("external");
  });

  it("rolls directory creation and removal back in reverse order after a later publish conflict", async () => {
    const failTarget = (suffix: string): WorkspacePort => new Proxy(workspace, {
      get(target, property) {
        if (property === "publishCaptured") {
          return async (...args: Parameters<WorkspacePort["publishCaptured"]>) =>
            args[0].target.endsWith(suffix) ? false : target.publishCaptured(...args);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const createRollback = createAuthority({ workspace: failTarget("assets/item.txt") });
    await expect(createRollback.mutateSource({
      ref,
      steps: [
        { kind: "mkdir", path: "assets" as RelPath, expectExisting: "absent" },
        { kind: "write", path: "assets/item.txt" as RelPath, content: "item", expectedContentHash: null },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    await expect(readdir(path.join(projectRoot, "assets"))).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(path.join(projectRoot, "assets/sub"), { recursive: true });
    await writeFile(path.join(projectRoot, "assets/sub/item.txt"), "item");
    const removeRollback = createAuthority({ workspace: failTarget("compositions/a.html") });
    await expect(removeRollback.mutateSource({
      ref,
      steps: [
        { kind: "delete", path: "assets/sub/item.txt" as RelPath, expectedContentHash: hash("item") },
        { kind: "rmdir", path: "assets/sub" as RelPath, expectEmpty: true },
        { kind: "rmdir", path: "assets" as RelPath, expectEmpty: true },
        { kind: "write", path: "compositions/a.html" as RelPath, content: "a-new", expectedContentHash: hash("a-old") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(await readFile(path.join(projectRoot, "assets/sub/item.txt"), "utf8")).toBe("item");
    expect(await readFile(path.join(projectRoot, "compositions/a.html"), "utf8")).toBe("a-old");
    expect(dbAll(database, "SELECT status FROM mutation_journal ORDER BY id")).toEqual([
      { status: "aborted" },
      { status: "aborted" },
    ]);
  });

  it("serializes a shared precondition race so one request wins and one never touches disk", async () => {
    const mutate = (content: string) => authority.mutateSource({
      ref,
      steps: [{ kind: "write", path: "index.html" as RelPath, content, expectedContentHash: hash("entry-old") }],
      origin: TEST_ORIGIN,
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
        origin: TEST_ORIGIN,
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
        origin: TEST_ORIGIN,
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
      origin: TEST_ORIGIN,
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
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent");

    expect(gated).toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("landed-before-t2");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
  });

  it("checks file and directory history read guards before opening the journal", async () => {
    await mkdir(path.join(projectRoot, "assets/shared"), { recursive: true });
    await writeFile(path.join(projectRoot, "assets/shared/font.woff2"), "font-v1");
    const result = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "entry-new",
        expectedContentHash: hash("entry-old"),
      }],
      origin: TEST_ORIGIN,
      historyReadGuards: [
        {
          path: "assets/shared/font.woff2" as RelPath,
          state: { kind: "file", contentHash: hash("font-v1") },
        },
        { path: "assets/shared" as RelPath, state: { kind: "directory" } },
      ],
      toolAudit: null,
      backup: false,
    }, "user");

    expect(result).toMatchObject({ ok: true, value: { projectRevision: 1 } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("entry-new");
  });

  it("returns write_conflict with zero writes when a history read guard changed", async () => {
    await mkdir(path.join(projectRoot, "assets/shared"), { recursive: true });
    await writeFile(path.join(projectRoot, "assets/shared/font.woff2"), "font-v2");
    const result = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "must-not-land",
        expectedContentHash: hash("entry-old"),
      }],
      origin: TEST_ORIGIN,
      historyReadGuards: [{
        path: "assets/shared/font.woff2" as RelPath,
        state: { kind: "file", contentHash: hash("font-v1") },
      }],
      toolAudit: null,
      backup: false,
    }, "user");

    expect(result).toMatchObject({ ok: false, error: { code: "write_conflict" } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("entry-old");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_journal")).toEqual({ count: 0 });

    const missingDirectory = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "must-not-land",
        expectedContentHash: hash("entry-old"),
      }],
      origin: TEST_ORIGIN,
      historyReadGuards: [{
        path: "assets/missing" as RelPath,
        state: { kind: "directory" },
      }],
      toolAudit: null,
      backup: false,
    }, "user");
    expect(missingDirectory).toMatchObject({ ok: false, error: { code: "write_conflict" } });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_journal")).toEqual({ count: 0 });
  });

  it("dedupes identical guards and rejects conflicting or mutation-target guards", async () => {
    await mkdir(path.join(projectRoot, "assets/shared"), { recursive: true });
    await writeFile(path.join(projectRoot, "assets/shared/font.woff2"), "font-v1");
    const guard = {
      path: "assets/shared/font.woff2" as RelPath,
      state: { kind: "file" as const, contentHash: hash("font-v1") },
    };
    const duplicate = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "entry-new",
        expectedContentHash: hash("entry-old"),
      }],
      origin: TEST_ORIGIN,
      historyReadGuards: [guard, guard],
      toolAudit: null,
      backup: false,
    }, "user");
    expect(duplicate).toMatchObject({ ok: true });

    await writeFile(path.join(projectRoot, "index.html"), "entry-old");
    const conflicting = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "must-not-land",
        expectedContentHash: hash("entry-old"),
      }],
      origin: TEST_ORIGIN,
      historyReadGuards: [guard, {
        ...guard,
        state: { kind: "file", contentHash: hash("font-v2") },
      }],
      toolAudit: null,
      backup: false,
    }, "user");
    expect(conflicting).toMatchObject({ ok: false, error: { code: "schema_invalid" } });

    const overlapsMutation = await authority.mutateSource({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "must-not-land",
        expectedContentHash: hash("entry-old"),
      }],
      origin: TEST_ORIGIN,
      historyReadGuards: [{
        path: "index.html" as RelPath,
        state: { kind: "file", contentHash: hash("entry-old") },
      }],
      toolAudit: null,
      backup: false,
    }, "user");
    expect(overlapsMutation).toMatchObject({ ok: false, error: { code: "schema_invalid" } });
  });
});
