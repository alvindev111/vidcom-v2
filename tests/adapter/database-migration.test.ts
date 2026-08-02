import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase, inspectDatabase } from "@vidcom/adapter";
import { dbOne, dbRun } from "../support/database";

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

describe("Drizzle migrations", () => {
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
          "revision.parent_revision->revision.id",
          "revision.project_id->project_registry.id",
          "revision_blob.revision_id->revision.id",
          "revision_step.backup_id->backup_manifest.id",
          "revision_step.revision_id->revision.id",
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
          "project_registry",
          "registry_cache",
          "revision",
          "revision_blob",
          "revision_step",
          "sqlite_sequence",
          "workspace_lease",
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

      expect(() => dbRun(database, `INSERT INTO mutation_journal
        (project_id, kind, path, to_hash, actor, created_at) VALUES ('p1','invalid','index.html','hash','user',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO mutation_journal
        (project_id, kind, path, to_hash, status, actor, created_at) VALUES ('p1','file','index.html','hash','invalid','user',?)`, now)).toThrow();
      expect(() => dbRun(database, `INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('invalid','p1','{}',?)`, now)).toThrow();
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
