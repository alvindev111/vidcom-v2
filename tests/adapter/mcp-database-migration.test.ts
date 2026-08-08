import { chmod, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSqliteClient,
  initializeDatabase,
  inspectMcpRollbackSafety,
  migrateDatabase,
  rollbackMcpMigration,
} from "@vidcom/adapter";
import { dbAll, dbOne, dbRun } from "../support/database";
import { hasPosixFileModes } from "../support/platform";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-migration-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function phaseOneDatabase() {
  const appData = path.join(root, "app-data");
  const migrations = path.join(root, "foundation-migrations");
  await mkdir(appData, { recursive: true });
  await mkdir(migrations, { recursive: true });
  await cp(
    new URL("../../packages/adapter/drizzle/20260801144629_foundation", import.meta.url),
    path.join(migrations, "20260801144629_foundation"),
    { recursive: true },
  );
  const database = createSqliteClient(path.join(appData, "vidcom.sqlite"));
  await migrateDatabase(database, migrations);
  return database;
}

describe("MCP database migration", () => {
  it("creates a fresh schema and reopens idempotently", async () => {
    const appData = path.join(root, "fresh-app-data");
    const database = await initializeDatabase(appData);
    expect(dbAll<{ name: string }>(database,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row.name)).toEqual(expect.arrayContaining([
      "approval_grant",
      "backup_manifest",
      "mcp_credential",
      "mutation_step",
      "revision_step",
    ]));
    await database.destroy();

    const reopened = await initializeDatabase(appData);
    expect(dbOne<{ count: number }>(reopened,
      "SELECT count(*) AS count FROM __drizzle_migrations",
    )).toEqual({ count: 13 });
    await reopened.destroy();
  });

  it("preserves Phase 1 rows and backfills only unresolved journals", async () => {
    const database = await phaseOneDatabase();
    const now = "2026-08-01T00:00:00.000Z";
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at)
      VALUES ('project-1', '/workspace', 'project-1', ?, ?)`, now, now);
    dbRun(database, `INSERT INTO revision
      (id, project_id, kind, path, entity, content_hash, parent_revision, actor, created_at)
      VALUES (7, 'project-1', 'file', 'index.html', NULL, 'sha256:old', NULL, 'user', ?)`, now);
    dbRun(database, `INSERT INTO revision
      (id, project_id, kind, path, entity, content_hash, parent_revision, actor, created_at)
      VALUES (8, 'project-1', 'entity', NULL, 'preview-settings', 'sha256:settings', 7, 'system', ?)`, now);
    dbRun(database, "INSERT INTO revision_blob (revision_id, previous_content, byte_size) VALUES (8, X'7B7D', 2)");
    dbRun(database, `INSERT INTO audit_entry
      (id, project_id, action, actor, revision_id, outcome, created_at)
      VALUES (9, 'project-1', 'entity.patch', 'system', 8, 'ok', ?)`, now);
    dbRun(database, `INSERT INTO mutation_journal
      (id, project_id, kind, path, entity, from_hash, previous_content, previous_byte_size,
       to_hash, status, actor, created_at)
      VALUES (11, 'project-1', 'file', 'index.html', NULL, 'sha256:old', X'6F6C64', 3,
       'sha256:new', 'pending', 'agent', ?)`, now);
    dbRun(database, `INSERT INTO mutation_journal
      (id, project_id, kind, path, entity, from_hash, previous_content, previous_byte_size,
       to_hash, status, actor, created_at)
      VALUES (12, 'project-1', 'entity', NULL, 'preview-settings', 'sha256:settings', X'7B7D', 2,
       'sha256:next', 'orphaned', 'system', ?)`, now);
    dbRun(database, `INSERT INTO mutation_journal
      (id, project_id, kind, path, entity, from_hash, previous_byte_size,
       to_hash, status, actor, created_at, settled_at)
      VALUES (13, 'project-1', 'file', 'done.html', NULL, NULL, 0,
       'sha256:done', 'committed', 'user', ?, ?)`, now, now);

    await migrateDatabase(database);

    expect(dbAll(database, "SELECT id, kind, parent_revision FROM revision ORDER BY id")).toEqual([
      { id: 7, kind: "file", parent_revision: null },
      { id: 8, kind: "entity", parent_revision: 7 },
    ]);
    expect(dbOne(database, "SELECT revision_id, byte_size FROM revision_blob")).toEqual({
      revision_id: 8,
      byte_size: 2,
    });
    expect(dbOne(database, "SELECT id, revision_id FROM audit_entry")).toEqual({ id: 9, revision_id: 8 });
    expect(dbAll(database, `SELECT journal_id, ordinal, kind, path, entity, status
      FROM mutation_step ORDER BY journal_id`)).toEqual([
      { journal_id: 11, ordinal: 0, kind: "write", path: "index.html", entity: null, status: "pending" },
      { journal_id: 12, ordinal: 0, kind: "entity", path: null, entity: "preview-settings", status: "pending" },
    ]);
    expect(dbOne<{ id: number }>(database, `INSERT INTO revision
      (project_id, kind, path, entity, content_hash, parent_revision, actor, created_at)
      VALUES ('project-1', 'composite', NULL, NULL, 'sha256:manifest', 8, 'agent', ?)
      RETURNING id`, now)?.id).toBeGreaterThan(8);
    expect(dbOne<{ violations: number }>(database,
      "SELECT count(*) AS violations FROM pragma_foreign_key_check",
    )).toEqual({ violations: 0 });

    await migrateDatabase(database);
    expect(dbOne<{ count: number }>(database, "SELECT count(*) AS count FROM mutation_step")).toEqual({ count: 2 });
    await database.destroy();
  });

  it("enforces MCP checks, foreign keys, uniqueness, JSON and database permissions", async () => {
    const appData = path.join(root, "constraint-app-data");
    const pathname = path.join(appData, "vidcom.sqlite");
    const database = await initializeDatabase(appData);
    const now = "2026-08-02T00:00:00.000Z";
    const hash = `sha256:${"a".repeat(64)}`;
    // Windows reports 0o666 regardless of the ACL; owner-only access there is
    // asserted against the real ACL in the credential-store suite.
    if (hasPosixFileModes) expect((await stat(pathname)).mode & 0o777).toBe(0o600);
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at)
      VALUES ('p1', '/workspace', 'p1', ?, ?)`, now, now);
    const revisionId = Number(dbRun(database, `INSERT INTO revision
      (project_id, kind, content_hash, actor, created_at)
      VALUES ('p1', 'composite', ?, 'agent', ?)`, hash, now).lastInsertRowid);
    dbRun(database, `INSERT INTO approval_grant
      (id, project_id, tool, target, expected_revision, plan_digest, target_hashes,
       summary, status, approver, created_at, expires_at)
      VALUES ('g1', 'p1', 'delete_file', 'index.html', ?, ?, '{}', 'Delete file', 'issued', 'cli', ?, ?)`,
    revisionId, hash, now, now);
    expect(() => dbRun(database, `INSERT INTO approval_grant
      (id, project_id, tool, target, expected_revision, plan_digest, target_hashes,
       summary, status, created_at, expires_at)
      VALUES ('bad-grant', 'p1', 'delete_file', 'index.html', -1, ?, 'not-json', 'Bad', 'invalid', ?, ?)`,
    hash, now, now)).toThrow();

    dbRun(database, `INSERT INTO backup_manifest
      (id, project_id, revision_id, reason, entries, manifest_hash, created_at)
      VALUES ('b1', 'p1', ?, 'tool:delete_file', '[]', ?, ?)`, revisionId, hash, now);
    expect(() => dbRun(database, `INSERT INTO backup_manifest
      (id, project_id, revision_id, reason, entries, manifest_hash, created_at)
      VALUES ('bad-backup', 'p1', NULL, 'tool:delete_file', 'bad-json', ?, ?)`, hash, now)).toThrow();

    dbRun(database, `INSERT INTO mcp_credential
      (id, label, secret_hash, status, created_at) VALUES ('c1', 'host', ?, 'active', ?)`, hash, now);
    expect(() => dbRun(database, `INSERT INTO mcp_credential
      (id, label, secret_hash, status, created_at) VALUES ('c2', 'host', ?, 'active', ?)`, hash, now)).toThrow();
    expect(() => dbRun(database, `INSERT INTO mcp_credential
      (id, label, secret_hash, status, created_at) VALUES ('bad-hash', 'host', ?, 'active', ?)`,
    `sha256:${"g".repeat(64)}`, now)).toThrow();

    const journalId = Number(dbRun(database, `INSERT INTO mutation_journal
      (project_id, kind, to_hash, status, actor, grant_id, backup_id, tool_audit_json, created_at)
      VALUES ('p1', 'composite', NULL, 'rolled_back', 'agent', 'g1', 'b1', '{}', ?)`, now).lastInsertRowid);
    expect(() => dbRun(database, `INSERT INTO mutation_journal
      (project_id, kind, to_hash, actor, grant_id, created_at)
      VALUES ('p1', 'file', ?, 'agent', 'g1', ?)`, hash, now)).toThrow();
    expect(() => dbRun(database, `INSERT INTO mutation_journal
      (project_id, kind, to_hash, actor, tool_audit_json, created_at)
      VALUES ('p1', 'file', ?, 'agent', 'bad-json', ?)`, hash, now)).toThrow();

    dbRun(database, `INSERT INTO mutation_step
      (journal_id, ordinal, kind, path, from_hash, to_hash, previous_byte_size)
      VALUES (?, 0, 'write', 'index.html', NULL, ?, 0)`, journalId, hash);
    expect(() => dbRun(database, `INSERT INTO mutation_step
      (journal_id, ordinal, kind, path, entity, previous_byte_size)
      VALUES (?, 1, 'entity', 'index.html', NULL, 0)`, journalId)).toThrow();
    expect(() => dbRun(database, `INSERT INTO mutation_step
      (journal_id, ordinal, kind, path, previous_byte_size)
      VALUES (?, 0, 'delete', 'index.html', 0)`, journalId)).toThrow();

    dbRun(database, `INSERT INTO revision_step
      (revision_id, ordinal, kind, path, from_hash, to_hash, byte_size, backup_id)
      VALUES (?, 0, 'delete', 'index.html', ?, NULL, 0, 'b1')`, revisionId, hash);
    expect(() => dbRun(database, `INSERT INTO revision_step
      (revision_id, ordinal, kind, path, entity, byte_size)
      VALUES (?, 1, 'entity', 'index.html', NULL, 0)`, revisionId)).toThrow();
    expect(dbOne<{ violations: number }>(database,
      "SELECT count(*) AS violations FROM pragma_foreign_key_check",
    )).toEqual({ violations: 0 });
    await database.destroy();

    // Reopening must repair a loosened mode. Windows has no group/other bit for
    // chmod to loosen, so there is nothing to repair and nothing to assert.
    if (hasPosixFileModes) {
      await chmod(pathname, 0o644);
      const reopened = await initializeDatabase(appData);
      expect((await stat(pathname)).mode & 0o777).toBe(0o600);
      await reopened.destroy();
    }
  });

  it("refuses rollback with Phase 2 history or unresolved context", async () => {
    const database = await initializeDatabase(path.join(root, "refusal-app-data"));
    const now = "2026-08-02T00:00:00.000Z";
    const hash = `sha256:${"b".repeat(64)}`;
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at)
      VALUES ('p1', '/workspace', 'p1', ?, ?)`, now, now);
    dbRun(database, `INSERT INTO revision
      (project_id, kind, content_hash, actor, created_at)
      VALUES ('p1', 'composite', ?, 'agent', ?)`, hash, now);
    dbRun(database, `INSERT INTO approval_grant
      (id, project_id, tool, target, expected_revision, plan_digest, target_hashes,
       summary, status, created_at, expires_at)
      VALUES ('g1', 'p1', 'delete_file', 'index.html', 1, ?, '{}', 'Delete', 'reserved', ?, ?)`,
    hash, now, now);
    dbRun(database, `INSERT INTO mutation_journal
      (project_id, kind, to_hash, status, actor, created_at)
      VALUES ('p1', 'composite', NULL, 'rolled_back', 'agent', ?)` , now);
    dbRun(database, `INSERT INTO mutation_journal
      (project_id, kind, path, to_hash, status, actor, grant_id, tool_audit_json, created_at)
      VALUES ('p1', 'file', 'index.html', ?, 'pending', 'agent', 'g1', '{}', ?)`, hash, now);
    dbRun(database, `INSERT INTO mutation_journal
      (project_id, kind, path, to_hash, status, actor, created_at)
      VALUES ('p1', 'file', 'missing.html', NULL, 'aborted', 'agent', ?)`, now);

    expect(inspectMcpRollbackSafety(database)).toMatchObject({
      compositeRevisions: 1,
      compositeJournals: 1,
      rolledBackJournals: 1,
      unresolvedContextJournals: 1,
      invalidLegacyJournalShapes: 1,
      safe: false,
    });
    expect(() => rollbackMcpMigration(database)).toThrow(/rollback refused/);
    expect(dbOne(database, "SELECT name FROM sqlite_master WHERE name = 'mutation_step'")).toEqual({ name: "mutation_step" });
    await database.destroy();
  });

  it("rolls back a safe database without losing Phase 1 history", async () => {
    const database = await initializeDatabase(path.join(root, "safe-rollback-app-data"));
    const now = "2026-08-02T00:00:00.000Z";
    const hash = `sha256:${"c".repeat(64)}`;
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at)
      VALUES ('p1', '/workspace', 'p1', ?, ?)`, now, now);
    const revisionId = Number(dbRun(database, `INSERT INTO revision
      (id, project_id, kind, path, content_hash, actor, created_at)
      VALUES (15, 'p1', 'file', 'index.html', ?, 'user', ?)`, hash, now).lastInsertRowid);
    dbRun(database, "INSERT INTO revision_blob (revision_id, byte_size) VALUES (?, 0)", revisionId);
    dbRun(database, `INSERT INTO audit_entry
      (project_id, action, actor, revision_id, outcome, created_at)
      VALUES ('p1', 'file.write', 'user', ?, 'ok', ?)`, revisionId, now);
    dbRun(database, `INSERT INTO mutation_journal
      (id, project_id, kind, path, to_hash, status, actor, created_at, settled_at)
      VALUES (21, 'p1', 'file', 'index.html', ?, 'committed', 'user', ?, ?)`, hash, now, now);

    expect(inspectMcpRollbackSafety(database)).toMatchObject({ safe: true });
    rollbackMcpMigration(database);

    expect(dbAll<{ name: string }>(database,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row.name)).not.toEqual(expect.arrayContaining([
      "approval_grant", "backup_manifest", "mcp_credential", "mutation_step", "revision_step",
    ]));
    expect(dbOne(database, "SELECT id, kind FROM revision")).toEqual({ id: 15, kind: "file" });
    expect(dbOne(database, "SELECT id, status FROM mutation_journal")).toEqual({ id: 21, status: "committed" });
    expect(dbOne<{ violations: number }>(database,
      "SELECT count(*) AS violations FROM pragma_foreign_key_check",
    )).toEqual({ violations: 0 });
    await database.destroy();
  });
});
