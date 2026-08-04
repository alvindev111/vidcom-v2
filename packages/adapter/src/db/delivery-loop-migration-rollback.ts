import { sql } from "drizzle-orm";

import type { VidcomDatabase } from "./client";

/** State that must be absent before the project-delivery schema can be rolled back safely. */
export interface DeliveryLoopRollbackSafetyReport {
  partialJobs: number;
  unresolvedWorkspaceOperations: number;
  safe: boolean;
}

/** Counts terminal data that the preceding job/workspace schema cannot represent. */
export function inspectDeliveryLoopRollbackSafety(
  database: VidcomDatabase,
): DeliveryLoopRollbackSafetyReport {
  const counts = database.get<{ partialJobs: number; unresolvedWorkspaceOperations: number }>(sql`
    SELECT
      (SELECT count(*) FROM job WHERE status = 'partial') AS partialJobs,
      (SELECT count(*) FROM workspace_operation WHERE status IN ('pending', 'orphaned'))
        AS unresolvedWorkspaceOperations
  `);
  if (!counts) throw new Error("could not inspect project-delivery rollback safety");
  return { ...counts, safe: counts.partialJobs === 0 && counts.unresolvedWorkspaceOperations === 0 };
}

/** Rebuilds the job table only after proving no partial outcome or workspace operation would be lost. */
export function rollbackDeliveryLoopMigration(database: VidcomDatabase): void {
  const report = inspectDeliveryLoopRollbackSafety(database);
  if (!report.safe) {
    throw new Error(
      `Project-delivery migration rollback refused: partialJobs=${report.partialJobs}, `
      + `unresolvedWorkspaceOperations=${report.unresolvedWorkspaceOperations}`,
    );
  }

  const client = database.$client;
  client.exec("PRAGMA foreign_keys = OFF");
  try {
    client.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE __rollback_job (
        id text PRIMARY KEY,
        project_id text REFERENCES project_registry(id),
        type text NOT NULL,
        status text DEFAULT 'queued' NOT NULL,
        input text NOT NULL,
        progress real DEFAULT 0 NOT NULL,
        stage text,
        result text,
        error_code text,
        error_message text,
        attempt integer DEFAULT 0 NOT NULL,
        idempotency_key text,
        input_hash text NOT NULL,
        cancel_requested integer DEFAULT 0 NOT NULL,
        worker_id text,
        heartbeat_at text,
        created_at text NOT NULL,
        started_at text,
        finished_at text,
        CONSTRAINT ck_job_progress CHECK(progress BETWEEN 0 AND 1),
        CONSTRAINT ck_job_attempt CHECK(attempt >= 0),
        CONSTRAINT ck_job_status CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        CONSTRAINT ck_job_cancel CHECK(cancel_requested IN (0, 1))
      );
      INSERT INTO __rollback_job (
        id, project_id, type, status, input, progress, stage, result, error_code,
        error_message, attempt, idempotency_key, input_hash, cancel_requested,
        worker_id, heartbeat_at, created_at, started_at, finished_at
      ) SELECT
        id, project_id, type, status, input, progress, stage, result, error_code,
        error_message, attempt, idempotency_key, input_hash, cancel_requested,
        worker_id, heartbeat_at, created_at, started_at, finished_at
      FROM job;
      DROP TABLE job;
      ALTER TABLE __rollback_job RENAME TO job;
      CREATE INDEX idx_job_type ON job(type);
      CREATE INDEX idx_job_claim ON job(status, type, created_at);
      CREATE INDEX idx_job_recovery ON job(status, heartbeat_at);
      CREATE UNIQUE INDEX uq_job_idempotency ON job(project_id, type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      DROP TABLE workspace_operation_step;
      DROP TABLE workspace_operation;
      DROP INDEX idx_revision_source;
      DROP INDEX idx_revision_derived_path;
      COMMIT;
    `);
  } catch (error) {
    try { client.exec("ROLLBACK"); } catch { /* SQLite already rolled back or closed the transaction. */ }
    throw error;
  } finally {
    client.exec("PRAGMA foreign_keys = ON");
  }

  const violation = client.prepare("SELECT count(*) AS count FROM pragma_foreign_key_check").get() as { count: number };
  if (violation.count !== 0) {
    throw new Error(`Project-delivery migration rollback left ${violation.count} foreign-key violations`);
  }
}
