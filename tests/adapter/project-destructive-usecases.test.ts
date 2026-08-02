import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  ApprovalService,
  createScene,
  DEFAULT_PREVIEW_SETTINGS,
  deleteScene,
  prepareSceneDeletion,
  reconcileCompositeMutation,
  restoreBackup,
  saveSourceFile,
  serializePreviewSettings,
  WriteAuthority,
  type AbsolutePath,
  type PendingToolAudit,
  type ProjectRef,
  type WorkspacePort,
} from "@vidcom/core";
import {
  AppDataBackupStore,
  CompositionHf,
  initializeDatabase,
  MutationJournal,
  SqliteApprovalGrantStore,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";

import { createFixedClock, createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne, dbRun } from "../support/database";

const now = "2026-08-02T00:00:00.000Z";
const projectId = "project_destructive_usecases" as ProjectId;
const hashContent = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

const indexSource = `<!doctype html><html><body>
<main data-hf-id="root" data-composition-id="root" data-width="1920" data-height="1080" data-duration="4">
  <div data-hf-id="scene-1-host" data-composition-id="scene-1" data-composition-src="compositions/scene-1.html" data-start="0" data-duration="4" data-track-index="1"></div>
</main></body></html>`;
const sceneSource = `<!doctype html><html><body><section data-hf-id="scene-1" data-composition-id="scene-1" data-width="1920" data-height="1080" data-start="0" data-duration="4"><h1 data-hf-id="title">Scene one</h1></section></body></html>`;

let root: string;
let appData: string;
let projectRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let workspace: WorkspaceFs;
let composition: CompositionHf;
let journal: MutationJournal;
let backups: AppDataBackupStore;
let authority: WriteAuthority;
let lease: WorkspaceLease;
let leaseId: string;
let ref: ProjectRef;
const clock = createFixedClock(now);

function audit(tool: string, level: "write" | "destructive"): PendingToolAudit {
  return {
    schemaVersion: 1,
    invocationId: `invocation-${tool}`,
    tool,
    level,
    projectId,
    era: "modern",
    protocolVersion: "2026-07-28",
    detail: { sceneId: "scene-1" },
    credentialId: "credential-test",
    invokedAt: now,
  };
}

async function missing(target: string): Promise<boolean> {
  try { await access(target); return false; }
  catch { return true; }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-project-destructive-"));
  appData = path.join(root, "app-data");
  const workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  await mkdir(path.join(projectRoot, "compositions"), { recursive: true });
  await mkdir(path.join(projectRoot, "narration"), { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
  await writeFile(path.join(projectRoot, "index.html"), indexSource);
  await writeFile(path.join(projectRoot, "compositions/scene-1.html"), sceneSource);
  const preview = serializePreviewSettings({
    ...DEFAULT_PREVIEW_SETTINGS,
    scenes: { "scene-1": { transitionSound: "minimal", revealSound: "ping", hidden: false } },
  });
  await writeFile(path.join(projectRoot, "preview-settings.json"), preview);
  await writeFile(path.join(projectRoot, "narration/scene-1.json"), `${JSON.stringify({
    sceneId: "scene-1", text: "Scene one", voice: "af_heart", status: "generated",
    audioPath: "narration/scene-1.wav", command: "tts", revision: 1, updatedAt: now, staleSince: null,
  }, null, 2)}\n`);
  await writeFile(path.join(projectRoot, "narration/scene-1.wav"), new Uint8Array([82, 73, 70, 70]));
  await writeFile(path.join(projectRoot, "notes.txt"), "notes old");

  database = await initializeDatabase(appData);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
  projectId, workspaceRoot, now, now);
  dbRun(database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 0, ?, 'preview-settings.json', 'system', ?)`,
  projectId, hashContent(preview), now);
  ref = { id: projectId, slug: "project", root: projectRoot as AbsolutePath, entry: "index.html" as RelPath };
  workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  composition = new CompositionHf();
  journal = new MutationJournal(database, clock);
  backups = new AppDataBackupStore(appData, database, clock, { newId: () => "backup_scene_delete" });
  lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:project-destructive");
  if (!acquired.ok) throw new Error("test lease was denied");
  leaseId = acquired.leaseId;
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId,
    hashContent,
    validateFileContent(path, content) {
      return typeof content === "string"
        ? composition.validateSource?.(path, content) ?? Promise.resolve({ ok: true as const, value: undefined })
        : Promise.resolve({ ok: true as const, value: undefined });
    },
    invalidate() {},
    notifyEvents() {},
    backups,
  });
});

function authorityWithFailure(options: { writePath?: string; deletePath?: string }): WriteAuthority {
  const proxy: WorkspacePort = {
    resolve: workspace.resolve.bind(workspace),
    listProjects: workspace.listProjects.bind(workspace),
    readProjectRef: workspace.readProjectRef.bind(workspace),
    readFile: workspace.readFile.bind(workspace),
    readBytes: workspace.readBytes.bind(workspace),
    readHash: workspace.readHash.bind(workspace),
    async writeAtomic(target, content) {
      if (options.writePath && target.endsWith(options.writePath)) throw new Error("injected write failure");
      await workspace.writeAtomic(target, content);
    },
    exists: workspace.exists.bind(workspace),
    async deleteAtomic(target) {
      if (options.deletePath && target.endsWith(options.deletePath)) throw new Error("injected delete failure");
      await workspace.deleteAtomic(target);
    },
    readTree: workspace.readTree.bind(workspace),
    stat: workspace.stat.bind(workspace),
  };
  return new WriteAuthority({
    workspace: proxy,
    journal,
    compositeJournal: journal,
    lease,
    leaseId,
    hashContent,
    invalidate() {},
    notifyEvents() {},
    backups,
  });
}

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("Phase J use cases with real SQLite and filesystem", () => {
  it("commits create_scene atomically and forwards composite plus one-step tool audits", async () => {
    const created = await createScene({ workspace, composition, journal, authority, clock }, {
      projectId,
      title: "Scene two",
      expectedContentHash: hashContent(indexSource),
    }, "agent", { toolAudit: audit("create_scene", "write") });
    expect(created).toMatchObject({ ok: true, value: { scene: { id: "scene-2" }, envelope: { projectRevision: 1 } } });
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(false);
    expect(await missing(path.join(projectRoot, "narration/scene-2.json"))).toBe(false);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision WHERE id = 1")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision_step WHERE revision_id = 1")).toEqual({ count: 3 });
    expect(dbOne(database, `SELECT revision_id AS revisionId FROM audit_entry
      WHERE action = 'tool:create_scene'`)).toEqual({ revisionId: 1 });

    const saved = await saveSourceFile({ workspace, composition, journal, authority, clock }, {
      projectId,
      path: "notes.txt" as RelPath,
      content: "notes new",
      expectedContentHash: hashContent("notes old"),
    }, "agent", { toolAudit: audit("save_file", "write") });
    expect(saved).toMatchObject({ ok: true, value: { envelope: { projectRevision: 2 } } });
    expect(dbOne(database, `SELECT revision_id AS revisionId FROM audit_entry
      WHERE action = 'tool:save_file'`)).toEqual({ revisionId: 2 });
    expect(dbOne(database, "SELECT kind FROM revision WHERE id = 2")).toEqual({ kind: "file" });
  });

  it("rolls create_scene back after a mid-step filesystem failure without revision or audit", async () => {
    const failing = authorityWithFailure({ writePath: "index.html" });
    const created = await createScene({ workspace, composition, journal, authority: failing, clock }, {
      projectId,
      title: "Must roll back",
      expectedContentHash: hashContent(indexSource),
    }, "agent", { toolAudit: audit("create_scene", "write") });
    expect(created).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(true);
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(indexSource);
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "aborted" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
  });

  it("keeps create_scene recovery-gated at T2 failure then reconciles exactly one tool audit", async () => {
    dbRun(database, `CREATE TRIGGER fail_create_t2 BEFORE INSERT ON revision
      BEGIN SELECT RAISE(ABORT, 'injected T2 failure'); END`);
    const created = await createScene({ workspace, composition, journal, authority, clock }, {
      projectId,
      title: "Landed before T2",
      expectedContentHash: hashContent(indexSource),
    }, "agent", { toolAudit: audit("create_scene", "write") });
    expect(created).toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(await missing(path.join(projectRoot, "compositions/scene-2.html"))).toBe(false);
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "pending" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });

    dbRun(database, "DROP TRIGGER fail_create_t2");
    await expect(reconcileCompositeMutation({
      workspace,
      journal,
      async resolveProjectRef() { return ref; },
    }, 1 as never)).resolves.toMatchObject({ ok: true, value: { terminal: "committed" } });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "committed" });
    expect(dbOne(database, `SELECT COUNT(*) AS count FROM audit_entry
      WHERE action = 'tool:create_scene'`)).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
  });

  it("rolls delete_scene back after a mid-delete failure and releases the grant without audit", async () => {
    const prepared = await prepareSceneDeletion({ workspace, composition, journal, hashContent }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const approvals = new ApprovalService({
      grants: new SqliteApprovalGrantStore(database),
      clock,
      ids: { newId: () => "grant_scene_failure" },
    });
    await approvals.request(prepared.value.binding, "Delete scene-1");
    await approvals.issue("grant_scene_failure", "cli");
    const failing = authorityWithFailure({ deletePath: "narration/scene-1.wav" });
    const deleted = await deleteScene({
      workspace,
      composition,
      journal,
      authority: failing,
      clock,
      hashContent,
    }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
      grantId: "grant_scene_failure",
    }, "agent", { toolAudit: audit("delete_scene", "destructive") });

    expect(deleted).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe(indexSource);
    expect(await readFile(path.join(projectRoot, "compositions/scene-1.html"), "utf8")).toBe(sceneSource);
    expect(await missing(path.join(projectRoot, "narration/scene-1.json"))).toBe(false);
    expect(await missing(path.join(projectRoot, "narration/scene-1.wav"))).toBe(false);
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = 1")).toEqual({ status: "aborted" });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant_scene_failure'"))
      .toEqual({ status: "issued" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
  });

  it("deletes all scene targets with one revision/backup and rejects restore after a later edit", async () => {
    const prepared = await prepareSceneDeletion({ workspace, composition, journal, hashContent }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const approvals = new ApprovalService({
      grants: new SqliteApprovalGrantStore(database),
      clock,
      ids: { newId: () => "grant_scene_delete" },
    });
    await approvals.request(prepared.value.binding, "Delete scene-1");
    await expect(approvals.issue("grant_scene_delete", "cli")).resolves.toMatchObject({ ok: true });

    const deleted = await deleteScene({ workspace, composition, journal, authority, clock, hashContent }, {
      projectId,
      sceneId: "scene-1",
      expectedRevision: 0,
      grantId: "grant_scene_delete",
    }, "agent", { toolAudit: audit("delete_scene", "destructive") });
    expect(deleted).toMatchObject({
      ok: true,
      value: {
        project: { duration: 0, sceneCount: 0, revision: 1 },
        envelope: { projectRevision: 1, diagnostics: [{ code: "composition_empty" }] },
        deletedFile: "compositions/scene-1.html",
        backupId: "backup_scene_delete",
      },
    });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).not.toContain("scene-1-host");
    expect(await missing(path.join(projectRoot, "compositions/scene-1.html"))).toBe(true);
    expect(await missing(path.join(projectRoot, "narration/scene-1.json"))).toBe(true);
    expect(await missing(path.join(projectRoot, "narration/scene-1.wav"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(projectRoot, "preview-settings.json"), "utf8")).scenes)
      .not.toHaveProperty("scene-1");
    expect(await backups.verify("backup_scene_delete")).toBe(true);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision WHERE id = 1")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision_step WHERE revision_id = 1")).toEqual({ count: 5 });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant_scene_delete'"))
      .toEqual({ status: "consumed" });
    expect(dbOne(database, `SELECT revision_id AS revisionId FROM audit_entry
      WHERE action = 'tool:delete_scene'`)).toEqual({ revisionId: 1 });

    const afterDelete = await readFile(path.join(projectRoot, "index.html"), "utf8");
    const later = await authority.mutateComposite({
      ref,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: `${afterDelete}\n<!-- later edit -->`,
        expectedContentHash: hashContent(afterDelete),
      }],
      toolAudit: null,
      backup: false,
    }, "user");
    expect(later).toMatchObject({ ok: true, value: { projectRevision: 2 } });
    await expect(restoreBackup({ backups, journal, workspace, writes: authority }, {
      projectId,
      backupId: "backup_scene_delete",
    }, "cli-external")).resolves.toMatchObject({ ok: false, error: { code: "write_conflict" } });
    expect(dbAll(database, "PRAGMA foreign_key_check")).toEqual([]);
  });
});
