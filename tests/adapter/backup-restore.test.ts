import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  restoreBackup,
  WriteAuthority,
  type AbsolutePath,
  type PendingToolAudit,
  type ProjectRef,
} from "@vidcom/core";
import {
  AppDataBackupStore,
  initializeDatabase,
  MutationJournal,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";

import { createFixedClock, createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne, dbRun } from "../support/database";

const now = "2026-08-02T00:00:00.000Z";
const projectId = "project_backup_restore" as ProjectId;
const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

let root: string;
let appData: string;
let projectRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let journal: MutationJournal;
let workspace: WorkspaceFs;
let backups: AppDataBackupStore;
let authority: WriteAuthority;
let ref: ProjectRef;

const toolAudit: PendingToolAudit = {
  schemaVersion: 1,
  invocationId: "invocation-delete-scene",
  tool: "delete_scene",
  level: "destructive",
  projectId,
  era: "modern",
  protocolVersion: "2026-07-28",
  detail: { sceneId: "scene-1" },
  credentialId: "credential-1",
  invokedAt: now,
  revisionBefore: 0,
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-backup-restore-"));
  appData = path.join(root, "app-data");
  const workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
  await writeFile(path.join(projectRoot, "index.html"), "before destructive");

  database = await initializeDatabase(appData);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
  projectId, workspaceRoot, now, now);
  const clock = createFixedClock(now);
  workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  journal = new MutationJournal(database, clock);
  backups = new AppDataBackupStore(appData, database, clock, { newId: () => "backup_destructive" });
  const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:backup-restore");
  if (!acquired.ok) throw new Error("test lease was denied");
  ref = {
    id: projectId,
    slug: "project",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId: acquired.leaseId,
    hashContent: hash,
    invalidate() {},
    notifyEvents() {},
    backups,
  });
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

async function destructiveWrite() {
  const result = await authority.mutateComposite({
    ref,
    steps: [{
      kind: "write",
      path: "index.html" as RelPath,
      content: "after destructive",
      expectedContentHash: hash("before destructive"),
    }],
    toolAudit,
    backup: true,
  }, "agent");
  expect(result).toMatchObject({ ok: true, value: { projectRevision: 1 } });
}

describe("backup restore with real SQLite and filesystem", () => {
  it("links destructive revision/audit IDs and restores as a new cli-external revision", async () => {
    await destructiveWrite();
    expect(await backups.read("backup_destructive")).toMatchObject({ revisionId: 1 });
    expect(dbOne(database, `SELECT backup_id AS backupId FROM revision_step
      WHERE revision_id = 1`)).toEqual({ backupId: "backup_destructive" });
    const destructiveAudit = dbOne<{ revisionId: number; detail: string }>(database, `SELECT
      revision_id AS revisionId, detail FROM audit_entry WHERE action = 'tool:delete_scene'`);
    expect(destructiveAudit?.revisionId).toBe(1);
    expect(JSON.parse(destructiveAudit?.detail ?? "null")).toMatchObject({ backupId: "backup_destructive" });

    const restored = await restoreBackup({
      backups,
      journal,
      workspace,
      writes: authority,
    }, { projectId, backupId: "backup_destructive" }, "cli-external");

    expect(restored).toMatchObject({ ok: true, value: { projectRevision: 2 } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("before destructive");
    expect(dbOne(database, "SELECT actor, parent_revision AS parentRevision FROM revision WHERE id = 2"))
      .toEqual({ actor: "cli-external", parentRevision: 1 });
    expect(dbOne(database, `SELECT from_hash AS fromHash, to_hash AS toHash
      FROM revision_step WHERE revision_id = 2`)).toEqual({
      fromHash: hash("after destructive"),
      toHash: hash("before destructive"),
    });
    expect(dbOne(database, `SELECT revision_id AS revisionId, actor, detail
      FROM audit_entry WHERE action = 'cli:restore'`)).toEqual({
      revisionId: 2,
      actor: "cli-external",
      detail: JSON.stringify({ backupId: "backup_destructive" }),
    });
  });

  it("rejects restore when a later edit no longer matches the destructive to_hash", async () => {
    await destructiveWrite();
    const later = await authority.mutateComposite({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "later edit",
        expectedContentHash: hash("after destructive"),
      }],
      toolAudit: null,
      backup: false,
    }, "user");
    expect(later).toMatchObject({ ok: true, value: { projectRevision: 2 } });

    await expect(restoreBackup({ backups, journal, workspace, writes: authority }, {
      projectId,
      backupId: "backup_destructive",
    }, "cli-external")).resolves.toMatchObject({
      ok: false,
      error: { code: "write_conflict" },
    });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("later edit");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 2 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry WHERE action = 'cli:restore'"))
      .toEqual({ count: 0 });
  });

  it("retains manifest and revision foreign keys after payload prune", async () => {
    await destructiveWrite();
    await expect(backups.prunePayloads(new Date("2026-08-03T00:00:00.000Z"))).resolves.toBe(1);
    await expect(backups.read("backup_destructive")).resolves.toMatchObject({
      revisionId: 1,
      payloadPrunedAt: now,
    });
    expect(dbOne(database, `SELECT backup_id AS backupId FROM revision_step
      WHERE revision_id = 1`)).toEqual({ backupId: "backup_destructive" });
    const retainedAudit = dbOne<{ revisionId: number; detail: string }>(database, `SELECT
      revision_id AS revisionId, detail FROM audit_entry WHERE action = 'tool:delete_scene'`);
    expect(retainedAudit?.revisionId).toBe(1);
    expect(JSON.parse(retainedAudit?.detail ?? "null")).toMatchObject({ backupId: "backup_destructive" });
    expect(dbAll(database, "PRAGMA foreign_key_check")).toEqual([]);
    await expect(restoreBackup({ backups, journal, workspace, writes: authority }, {
      projectId,
      backupId: "backup_destructive",
    }, "cli-external")).resolves.toMatchObject({
      ok: false,
      error: { code: "backup_expired" },
    });
  });
});
