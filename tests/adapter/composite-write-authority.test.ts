import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  serializePreviewSettings,
  WriteAuthority,
  type AbsolutePath,
  type ClockPort,
  type ProjectRef,
} from "@vidcom/core";
import { initializeDatabase, MutationJournal, WorkspaceFs, WorkspaceLease } from "@vidcom/adapter";

import { createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne, dbRun } from "../support/database";

let root: string;
let projectRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let authority: WriteAuthority;
let ref: ProjectRef;

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

  database = await initializeDatabase(path.join(root, "app-data"));
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
  const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  const journal = new MutationJournal(database, clock);
  const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:composite");
  if (!acquired.ok) throw new Error("test lease was denied");
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId: acquired.leaseId,
    hashContent: hash,
    invalidate() {},
    notifyEvents() {},
  });
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("Composite WriteAuthority with real SQLite and filesystem", () => {
  it("commits ordered multi-file steps as one composite revision", async () => {
    const result = await authority.mutateComposite({
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
    const result = await authority.mutateComposite({
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
    const mutate = (content: string) => authority.mutateComposite({
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

  it("keeps landed bytes and gates the next write when T2 cannot commit", async () => {
    dbRun(database, `CREATE TRIGGER fail_composite_commit
      BEFORE INSERT ON revision_step
      BEGIN SELECT RAISE(ABORT, 'injected T2 failure'); END`);

    const failedCommit = await authority.mutateComposite({
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
    const gated = await authority.mutateComposite({
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
