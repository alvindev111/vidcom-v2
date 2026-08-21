import { cp, mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteClient, initializeDatabase, inspectDatabase, migrateDatabase } from "@vidcom/adapter";
import { dbAll, dbOne, dbRun } from "../support/database";

const HOST_EVENT_MIGRATION = "20260807144527_amazing_kitty_pryde";
const PROJECT_IMPORT_MIGRATION = "20260808073614_normal_stature";
const DIRECTORY_STEP_MIGRATION = "20260817153223_small_power_pack";
const PENDING_MOUNT_MIGRATION = "20260817162114_solid_daredevil";

let root: string;
let appData: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-db-test-"));
  appData = path.join(root, "app-data");
  workspace = path.join(root, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const insertProject = (database: Awaited<ReturnType<typeof initializeDatabase>>, id: string, slug: string) =>
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  id, workspace, slug, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");

/** Builds a database migrated only up to (not including) `boundary`. */
async function databaseBefore(boundary: string, label: string) {
  const migrations = path.join(root, label);
  const source = new URL("../../packages/adapter/drizzle/", import.meta.url);
  await mkdir(appData, { recursive: true });
  await mkdir(migrations, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name >= boundary) continue;
    await cp(new URL(`${entry.name}/`, source), path.join(migrations, entry.name), { recursive: true });
  }
  const database = createSqliteClient(path.join(appData, "vidcom.sqlite"));
  await migrateDatabase(database, migrations);
  return database;
}

function databaseBeforeHostEvents() {
  return databaseBefore(HOST_EVENT_MIGRATION, "prior-host-event-migrations");
}

describe("Drizzle migrations", () => {
  it("preserves journal rows and foreign keys while adding pending mounts", async () => {
    const database = await databaseBefore(PENDING_MOUNT_MIGRATION, "prior-pending-mount-migrations");
    const now = "2026-08-17T00:00:00.000Z";
    try {
      insertProject(database, "p-pending", "pending");
      dbRun(database, `INSERT INTO mutation_journal
        (project_id, kind, path, from_hash, to_hash, status, actor, created_at)
        VALUES ('p-pending', 'file', 'index.html', 'sha256:old', 'sha256:new', 'committed', 'agent', ?)`, now);

      await migrateDatabase(database);
      await migrateDatabase(database);

      expect(dbOne(database, `SELECT id, project_id AS projectId, status, pending_transition AS transition
        FROM mutation_journal WHERE id = 1`)).toEqual({
        id: 1,
        projectId: "p-pending",
        status: "committed",
        transition: null,
      });
      expect(() => dbRun(database, `INSERT INTO pending_mount
        (operation_id, project_id, asset_path, asset_content_hash, upload_fingerprint,
         at_seconds, track_index, state, created_at, updated_at)
        VALUES ('operation-1', 'missing', 'assets/a.mp4', 'sha256:a', 'sha256:b', 0, 0,
          'uploaded_unmounted', ?, ?)`, now, now)).toThrow();
      expect(dbOne(database, "SELECT count(*) AS violations FROM pragma_foreign_key_check"))
        .toEqual({ violations: 0 });
    } finally {
      await database.destroy();
    }
  });

  it("preserves old steps while adding durable directory step state", async () => {
    const database = await databaseBefore(DIRECTORY_STEP_MIGRATION, "prior-directory-step-migrations");
    const now = "2026-08-17T00:00:00.000Z";
    try {
      insertProject(database, "p-directory", "directory");
      dbRun(database, `INSERT INTO mutation_journal
        (project_id, kind, path, from_hash, to_hash, status, actor, created_at)
        VALUES ('p-directory', 'file', 'index.html', 'sha256:old', 'sha256:new', 'pending', 'agent', ?)`, now);
      dbRun(database, `INSERT INTO mutation_step
        (journal_id, ordinal, kind, path, from_hash, to_hash, status)
        VALUES (1, 0, 'write', 'index.html', 'sha256:old', 'sha256:new', 'pending')`);
      dbRun(database, `INSERT INTO revision
        (project_id, kind, path, content_hash, actor, created_at)
        VALUES ('p-directory', 'file', 'index.html', 'sha256:new', 'agent', ?)`, now);
      dbRun(database, `INSERT INTO revision_step
        (revision_id, ordinal, kind, path, from_hash, to_hash)
        VALUES (1, 0, 'write', 'index.html', 'sha256:old', 'sha256:new')`);

      await migrateDatabase(database);

      expect(dbOne(database, "SELECT kind, existed_before AS existedBefore FROM mutation_step WHERE id = 1"))
        .toEqual({ kind: "write", existedBefore: null });
      expect(dbOne(database, "SELECT kind, existed_before AS existedBefore FROM revision_step WHERE id = 1"))
        .toEqual({ kind: "write", existedBefore: null });
      expect(() => dbRun(database, `INSERT INTO mutation_step
        (journal_id, ordinal, kind, path, existed_before, status)
        VALUES (1, 1, 'mkdir', 'assets', 0, 'pending')`)).not.toThrow();
      expect(() => dbRun(database, `INSERT INTO mutation_step
        (journal_id, ordinal, kind, path, status)
        VALUES (1, 2, 'rmdir', 'assets', 'pending')`)).toThrow();
      expect(dbOne(database, "SELECT count(*) AS violations FROM pragma_foreign_key_check"))
        .toEqual({ violations: 0 });
    } finally {
      await database.destroy();
    }
  });

  it("preserves existing outbox rows and sequence when adding host lifecycle events", async () => {
    const database = await databaseBeforeHostEvents();
    const now = "2026-08-07T00:00:00.000Z";
    try {
      insertProject(database, "p1", "one");
      dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('workspace.changed', NULL, '{"before":true}', ?)`, now);
      dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('file.changed', 'p1', '{"path":"index.html"}', ?)`, now);

      await migrateDatabase(database);

      expect(dbAll(database, `SELECT seq, type, project_id, payload FROM event_outbox ORDER BY seq`))
        .toEqual([
          { seq: 1, type: "workspace.changed", project_id: null, payload: '{"before":true}' },
          { seq: 2, type: "file.changed", project_id: "p1", payload: '{"path":"index.html"}' },
        ]);
      const appended = dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('runtime.ready', NULL, '{}', ?)`, now);
      expect(Number(appended.lastInsertRowid)).toBe(3);
      expect(dbOne(database, "SELECT count(*) AS violations FROM pragma_foreign_key_check"))
        .toEqual({ violations: 0 });
    } finally {
      await database.destroy();
    }
  });

  it("adds project_import without disturbing existing workspace operations", async () => {
    // The kind check constraint forces a table rebuild, which is the migration
    // shape most able to lose rows, renumber ids or drop a status silently.
    const database = await databaseBefore(PROJECT_IMPORT_MIGRATION, "prior-project-import-migrations");
    const now = "2026-08-07T00:00:00.000Z";
    try {
      insertProject(database, "p1", "one");
      const kinds = ["agent_kit_files", "project_create", "project_rename", "project_delete"] as const;
      const statuses = ["pending", "committed", "aborted", "recovered"] as const;
      kinds.forEach((kind, index) => {
        dbRun(database, `INSERT INTO workspace_operation
          (workspace_root, kind, project_id, status, actor, action, created_at)
          VALUES (?, ?, 'p1', ?, 'user', 'test', ?)`,
        workspace, kind, statuses[index] ?? "pending", now);
      });
      const before = dbAll(database, `SELECT id, kind, status FROM workspace_operation ORDER BY id`);
      expect(before).toHaveLength(4);

      // Before the migration the new kind is rejected by the old constraint.
      expect(() => dbRun(database, `INSERT INTO workspace_operation
        (workspace_root, kind, project_id, status, actor, action, created_at)
        VALUES (?, 'project_import', 'p1', 'pending', 'user', 'test', ?)`, workspace, now)).toThrow();

      await migrateDatabase(database);

      expect(dbAll(database, `SELECT id, kind, status FROM workspace_operation ORDER BY id`))
        .toEqual(before);
      expect(dbOne(database, "SELECT count(*) AS violations FROM pragma_foreign_key_check"))
        .toEqual({ violations: 0 });

      const imported = dbRun(database, `INSERT INTO workspace_operation
        (workspace_root, kind, project_id, status, actor, action, created_at)
        VALUES (?, 'project_import', 'p1', 'pending', 'user', 'test', ?)`, workspace, now);
      // Ids continue rather than restart, so a rebuilt table cannot collide with
      // an id some other row already references.
      expect(Number(imported.lastInsertRowid)).toBe(5);
      expect(() => dbRun(database, `INSERT INTO workspace_operation
        (workspace_root, kind, project_id, status, actor, action, created_at)
        VALUES (?, 'project_teleport', 'p1', 'pending', 'user', 'test', ?)`, workspace, now)).toThrow();
    } finally {
      await database.destroy();
    }
  });

  it("creates the app tables plus the Drizzle journal and is idempotent", async () => {
    const database = await initializeDatabase(appData);
    try {
      expect(await inspectDatabase(database)).toEqual({
        integrity: "ok",
        journalMode: "wal",
        foreignKeyViolations: 0,
        foreignKeys: [
          "approval_grant.project_id->project_registry.id",
          "audit_entry.job_id->job.id",
          "audit_entry.project_id->project_registry.id",
          "audit_entry.revision_id->revision.id",
          "backup_manifest.project_id->project_registry.id",
          "backup_manifest.revision_id->revision.id",
          "entity_state.project_id->project_registry.id",
          "event_outbox.project_id->project_registry.id",
          "job.project_id->project_registry.id",
          "mcp_credential.rotated_from->mcp_credential.id",
          "mutation_journal.backup_id->backup_manifest.id",
          "mutation_journal.grant_id->approval_grant.id",
          "mutation_journal.project_id->project_registry.id",
          "mutation_step.journal_id->mutation_journal.id",
          "pending_mount.project_id->project_registry.id",
          "revision.parent_revision->revision.id",
          "revision.project_id->project_registry.id",
          "revision_blob.revision_id->revision.id",
          "revision_step.backup_id->backup_manifest.id",
          "revision_step.revision_id->revision.id",
          "workspace_operation.grant_id->approval_grant.id",
          "workspace_operation_step.operation_id->workspace_operation.id",
        ],
        tables: [
          "__drizzle_migrations",
          "app_settings",
          "approval_grant",
          "audit_entry",
          "backup_manifest",
          "entity_state",
          "event_outbox",
          "job",
          "mcp_credential",
          "mutation_journal",
          "mutation_step",
          "pending_mount",
          "project_registry",
          "registry_cache",
          "revision",
          "revision_blob",
          "revision_step",
          "sqlite_sequence",
          "workspace_lease",
          "workspace_operation",
          "workspace_operation_step",
        ],
      });
      await expect(stat(path.join(appData, "vidcom.sqlite"))).resolves.toMatchObject({});
      await expect(stat(path.join(workspace, "vidcom.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await database.destroy();
    }

    const reopened = await initializeDatabase(appData);
    await expect(inspectDatabase(reopened)).resolves.toMatchObject({ integrity: "ok", journalMode: "wal" });
    await reopened.destroy();
  });

  it("enforces checks, foreign keys, composite keys and project-scoped partial uniqueness", async () => {
    const database = await initializeDatabase(appData);
    const now = "2026-08-01T00:00:00.000Z";
    const hash = `sha256:${"a".repeat(64)}`;
    const insertJob = (id: string, projectId: string, key: string | null, overrides: Record<string, unknown> = {}) => {
      const row = { status: "queued", progress: 0, attempt: 0, cancel: 0, ...overrides };
      return dbRun(database, `INSERT INTO job
        (id, project_id, type, status, progress, stage, input, input_hash, idempotency_key,
         attempt, cancel_requested, created_at)
        VALUES (?, ?, 'noop-probe', ?, ?, NULL, '{}', ?, ?, ?, ?, ?)`,
      id, projectId, row.status as string, row.progress as number, hash, key,
      row.attempt as number, row.cancel as number, now);
    };
    try {
      insertProject(database, "p1", "one");
      insertProject(database, "p2", "two");

      const insertPendingMount = (
        operationId: string,
        state: string,
        errorCode: string | null,
        errorMessage: string | null,
        sceneId: string | null,
        revision: number | null,
      ) => dbRun(database, `INSERT INTO pending_mount
        (operation_id, project_id, asset_path, asset_content_hash, upload_fingerprint,
         at_seconds, track_index, state, last_error_code, last_error_message,
         mounted_scene_id, mounted_revision, created_at, updated_at)
        VALUES (?, 'p1', 'assets/a.mp4', ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      operationId, hash, hash, state, errorCode, errorMessage, sceneId, revision, now, now);
      expect(() => insertPendingMount("pending-ok", "uploaded_unmounted", "interrupted", "retry", null, null))
        .not.toThrow();
      expect(() => insertPendingMount("pending-bad-pair", "uploaded_unmounted", "interrupted", null, null, null))
        .toThrow();
      expect(() => insertPendingMount("mounted-ok", "mounted", null, null, "scene-1", 1))
        .not.toThrow();
      expect(() => insertPendingMount("mounted-bad-error", "mounted", "failed", "bad", "scene-1", 1))
        .toThrow();
      expect(() => insertPendingMount("abandoned-ok", "abandoned", "abandoned", "ignored", null, null))
        .not.toThrow();
      expect(() => insertPendingMount("abandoned-no-reason", "abandoned", null, null, null, null))
        .toThrow();
      expect(() => dbRun(database, `INSERT INTO mutation_journal
        (project_id, kind, status, actor, pending_transition, created_at)
        VALUES ('p1', 'composite', 'pending', 'agent', '{bad-json', ?)` , now)).toThrow();

      expect(() => dbRun(database, `INSERT INTO mutation_journal
        (project_id, kind, path, to_hash, actor, created_at) VALUES ('p1','invalid','index.html','hash','user',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO mutation_journal
        (project_id, kind, path, to_hash, status, actor, created_at) VALUES ('p1','file','index.html','hash','invalid','user',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('invalid','p1','{}',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('workspace.lease_lost',NULL,'{}',?)`, now)).not.toThrow();
      expect(() => dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('workspace.reattached','p1','{}',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('file.changed',NULL,'{}',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO revision
        (project_id, kind, path, content_hash, actor, created_at) VALUES ('missing','file','index.html','hash','user',?)`, now)).toThrow();

      insertJob("j1", "p1", "same");
      expect(() => insertJob("j2", "p1", "same")).toThrow();
      expect(() => insertJob("j3", "p2", "same")).not.toThrow();
      expect(() => insertJob("j4", "p1", null)).not.toThrow();
      expect(() => insertJob("j5", "p1", null)).not.toThrow();
      expect(() => insertJob("bad-status", "p1", "bad-status", { status: "invalid" })).toThrow();
      expect(() => insertJob("bad-progress", "p1", "bad-progress", { progress: 2 })).toThrow();
      expect(() => insertJob("bad-attempt", "p1", "bad-attempt", { attempt: -1 })).toThrow();
      expect(() => insertJob("bad-cancel", "p1", "bad-cancel", { cancel: 2 })).toThrow();

      dbRun(database, `INSERT INTO entity_state
        (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
        VALUES ('p1','preview-settings',0,'hash','preview-settings.json','system',?)`, now);
      expect(() => dbRun(database, `INSERT INTO entity_state
        (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
        VALUES ('p2','preview-settings',0,'hash','preview-settings.json','invalid',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO entity_state
        (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
        VALUES ('p1','preview-settings',1,'hash2','preview-settings.json','system',?)`, now)).toThrow();

      const revisionId = Number(dbRun(database, `INSERT INTO revision
        (project_id, kind, path, content_hash, actor, created_at)
        VALUES ('p1','file','index.html','hash','user',?)`, now).lastInsertRowid);
      expect(() => dbRun(database, `INSERT INTO revision
        (project_id, kind, path, content_hash, actor, created_at) VALUES ('p1','invalid','index.html','hash','user',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO revision
        (project_id, kind, path, content_hash, actor, created_at) VALUES ('p1','file','index.html','hash','invalid',?)`, now)).toThrow();
      expect(() => dbRun(database, "INSERT INTO revision_blob (revision_id, byte_size) VALUES (?, -1)", revisionId)).toThrow();
      expect(() => dbRun(database, `INSERT INTO audit_entry
        (project_id, action, actor, outcome, created_at) VALUES ('p1','probe','invalid','ok',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO audit_entry
        (project_id, action, actor, outcome, created_at) VALUES ('p1','probe','system','invalid',?)`, now)).toThrow();
      expect(dbOne<{ violations: number }>(database,
        "SELECT count(*) AS violations FROM pragma_foreign_key_check")).toEqual({ violations: 0 });
    } finally {
      await database.destroy();
    }
  });

});
