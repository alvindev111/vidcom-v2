import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSqliteClient,
  inspectDeliveryLoopRollbackSafety,
  migrateDatabase,
  rollbackDeliveryLoopMigration,
} from "@vidcom/adapter";
import { dbAll, dbOne, dbRun } from "../support/database";

const DELIVERY_LOOP_MIGRATION = "20260804140510_flippant_tenebrous";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-delivery-migration-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function databaseBeforeDeliveryLoop() {
  const appData = path.join(root, "app-data");
  const migrations = path.join(root, "prior-migrations");
  const source = new URL("../../packages/adapter/drizzle/", import.meta.url);
  await mkdir(appData, { recursive: true });
  await mkdir(migrations, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name >= DELIVERY_LOOP_MIGRATION) continue;
    await cp(new URL(`${entry.name}/`, source), path.join(migrations, entry.name), { recursive: true });
  }
  const database = createSqliteClient(path.join(appData, "vidcom.sqlite"));
  await migrateDatabase(database, migrations);
  return database;
}

function seedLegacyRows(database: Awaited<ReturnType<typeof databaseBeforeDeliveryLoop>>): void {
  const now = "2026-08-04T00:00:00.000Z";
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at)
    VALUES ('p1', '/workspace', 'p1', ?, ?)`, now, now);
  dbRun(database, `INSERT INTO revision
    (id, project_id, kind, path, content_hash, actor, summary, created_at)
    VALUES (7, 'p1', 'file', 'index.html', 'sha256:old', 'user', 'legacy bytes', ?)`, now);
  dbRun(database, `INSERT INTO job
    (id, project_id, type, status, input, progress, stage, result, error_code,
     error_message, attempt, idempotency_key, input_hash, cancel_requested,
     worker_id, heartbeat_at, created_at, started_at, finished_at)
    VALUES ('j1', 'p1', 'snapshot', 'succeeded', '{"sceneIds":["s1"]}', 1,
      'done', '{"artifact":"snap.png"}', NULL, NULL, 1, 'snapshot:p1',
      'sha256:input', 0, NULL, NULL, ?, ?, ?)`, now, now, now);
}

describe("project-delivery SQLite migration", () => {
  it("preserves legacy rows and enforces source, job and workspace constraints", async () => {
    const database = await databaseBeforeDeliveryLoop();
    try {
      seedLegacyRows(database);
      await migrateDatabase(database);

      expect(dbOne(database, "SELECT advances_source FROM revision WHERE id = 7"))
        .toEqual({ advances_source: 1 });
      expect(() => dbRun(database, `INSERT INTO revision
        (project_id, kind, content_hash, actor, advances_source, created_at)
        VALUES ('p1', 'file', 'sha256:bad', 'user', 7, '2026-08-04T00:00:00.000Z')`)).toThrow();

      expect(dbOne(database, `SELECT id, project_id, type, status, input, progress, stage,
        result, attempt, idempotency_key, input_hash, cancel_requested, created_at,
        started_at, finished_at, warnings_json, cleanup_pending FROM job WHERE id = 'j1'`))
        .toEqual({
          id: "j1",
          project_id: "p1",
          type: "snapshot",
          status: "succeeded",
          input: '{"sceneIds":["s1"]}',
          progress: 1,
          stage: "done",
          result: '{"artifact":"snap.png"}',
          attempt: 1,
          idempotency_key: "snapshot:p1",
          input_hash: "sha256:input",
          cancel_requested: 0,
          created_at: "2026-08-04T00:00:00.000Z",
          started_at: "2026-08-04T00:00:00.000Z",
          finished_at: "2026-08-04T00:00:00.000Z",
          warnings_json: null,
          cleanup_pending: 0,
        });
      expect(() => dbRun(database, `INSERT INTO job
        (id, project_id, type, status, input, input_hash, created_at, result, warnings_json)
        VALUES ('partial', 'p1', 'snapshot', 'partial', '{}', 'sha256:partial',
          '2026-08-04T00:00:00.000Z', '{"missingSceneIds":["s2"]}', '[]')`)).not.toThrow();
      expect(() => dbRun(database, `INSERT INTO job
        (id, project_id, type, status, input, input_hash, created_at)
        VALUES ('render', 'p1', 'render', 'queued', '{}', 'sha256:render',
          '2026-08-04T00:00:00.000Z')`)).not.toThrow();
      expect(() => dbRun(database, "UPDATE job SET warnings_json = '{bad' WHERE id = 'j1'")).toThrow();
      expect(() => dbRun(database, "UPDATE job SET cleanup_pending = 2 WHERE id = 'j1'")).toThrow();

      expect(dbAll(database, "SELECT * FROM pragma_foreign_key_check")).toEqual([]);
      expect(dbOne(database, "PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
      expect(dbAll<{ name: string }>(database, `SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_revision_source', 'idx_revision_derived_path', 'idx_job_cleanup'
        ) ORDER BY name`).map((row) => row.name)).toEqual([
        "idx_job_cleanup",
        "idx_revision_derived_path",
        "idx_revision_source",
      ]);
    } finally {
      await database.destroy();
    }
  });

  it("refuses rollback with partial rows and rebuilds the legacy job shape when safe", async () => {
    const database = await databaseBeforeDeliveryLoop();
    try {
      seedLegacyRows(database);
      await migrateDatabase(database);
      dbRun(database, `INSERT INTO job
        (id, project_id, type, status, input, input_hash, created_at, result)
        VALUES ('partial', 'p1', 'snapshot', 'partial', '{}', 'sha256:partial',
          '2026-08-04T00:00:00.000Z', '{"missingSceneIds":["s2"]}')`);

      expect(inspectDeliveryLoopRollbackSafety(database)).toMatchObject({ partialJobs: 1, safe: false });
      expect(() => rollbackDeliveryLoopMigration(database)).toThrow(/partialJobs=1/);

      dbRun(database, "DELETE FROM job WHERE id = 'partial'");
      rollbackDeliveryLoopMigration(database);
      expect(dbOne(database, "SELECT status, result FROM job WHERE id = 'j1'"))
        .toEqual({ status: "succeeded", result: '{"artifact":"snap.png"}' });
      expect(() => dbRun(database, "UPDATE job SET status = 'partial' WHERE id = 'j1'")).toThrow();
      expect(dbAll(database, "SELECT * FROM pragma_foreign_key_check")).toEqual([]);
      expect(dbOne(database, "PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    } finally {
      await database.destroy();
    }
  });
});
