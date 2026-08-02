import { sql } from "drizzle-orm";

import type { VidcomDatabase } from "./client";

/** Row counts that must all be zero before the Phase 2 schema can be removed. */
export interface McpRollbackSafetyReport {
  compositeRevisions: number;
  compositeJournals: number;
  rolledBackJournals: number;
  unresolvedContextJournals: number;
  invalidLegacyJournalShapes: number;
  safe: boolean;
}

/** Inspects every history/context condition that would make a Phase 2 rollback destructive. */
export function inspectMcpRollbackSafety(database: VidcomDatabase): McpRollbackSafetyReport {
  const counts = database.get<{
    compositeRevisions: number;
    compositeJournals: number;
    rolledBackJournals: number;
    unresolvedContextJournals: number;
    invalidLegacyJournalShapes: number;
  }>(sql`
    SELECT
      (SELECT count(*) FROM revision WHERE kind = 'composite') AS compositeRevisions,
      (SELECT count(*) FROM mutation_journal WHERE kind = 'composite') AS compositeJournals,
      (SELECT count(*) FROM mutation_journal WHERE status = 'rolled_back') AS rolledBackJournals,
      (SELECT count(*) FROM mutation_journal
        WHERE status IN ('pending', 'orphaned')
          AND (grant_id IS NOT NULL OR backup_id IS NOT NULL OR tool_audit_json IS NOT NULL)
      ) AS unresolvedContextJournals,
      (SELECT count(*) FROM mutation_journal
        WHERE kind IN ('file', 'entity') AND to_hash IS NULL
      ) AS invalidLegacyJournalShapes
  `);
  if (!counts) throw new Error("could not inspect MCP rollback safety");
  return { ...counts, safe: Object.values(counts).every((count) => count === 0) };
}

/** Reverts only the MCP schema migration after a successful safety inspection. */
export function rollbackMcpMigration(database: VidcomDatabase): void {
  const report = inspectMcpRollbackSafety(database);
  if (!report.safe) {
    const blockers = Object.entries(report)
      .filter(([name, count]) => name !== "safe" && count !== 0)
      .map(([name, count]) => `${name}=${count}`)
      .join(", ");
    throw new Error(`MCP migration rollback refused; resolve or export Phase 2 state first: ${blockers}`);
  }

  const client = database.$client;
  client.exec("PRAGMA foreign_keys = OFF");
  try {
    client.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE __rollback_mutation_journal (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id text NOT NULL REFERENCES project_registry(id),
        kind text NOT NULL,
        path text,
        entity text,
        from_hash text,
        previous_content blob,
        previous_byte_size integer DEFAULT 0 NOT NULL,
        staged_tmp_path text,
        staged_target_path text,
        staged_content_hash text,
        to_hash text NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        actor text NOT NULL,
        created_at text NOT NULL,
        settled_at text,
        CONSTRAINT ck_journal_kind CHECK(kind IN ('file', 'entity')),
        CONSTRAINT ck_journal_status CHECK(status IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned')),
        CONSTRAINT ck_journal_actor CHECK(actor IN ('user', 'agent', 'cli-external', 'system')),
        CONSTRAINT ck_journal_previous_size CHECK(previous_byte_size >= 0)
      );
      INSERT INTO __rollback_mutation_journal (
        id, project_id, kind, path, entity, from_hash, previous_content, previous_byte_size,
        staged_tmp_path, staged_target_path, staged_content_hash, to_hash, status, actor, created_at, settled_at
      ) SELECT
        id, project_id, kind, path, entity, from_hash, previous_content, previous_byte_size,
        staged_tmp_path, staged_target_path, staged_content_hash, to_hash, status, actor, created_at, settled_at
      FROM mutation_journal;
      DROP TABLE mutation_journal;
      ALTER TABLE __rollback_mutation_journal RENAME TO mutation_journal;
      CREATE INDEX idx_journal_project ON mutation_journal(project_id);
      CREATE INDEX idx_journal_pending ON mutation_journal(status, created_at);

      CREATE TABLE __rollback_revision (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id text NOT NULL REFERENCES project_registry(id),
        kind text NOT NULL,
        path text,
        entity text,
        content_hash text NOT NULL,
        parent_revision integer REFERENCES revision(id),
        actor text NOT NULL,
        summary text,
        created_at text NOT NULL,
        CONSTRAINT ck_revision_kind CHECK(kind IN ('file', 'entity')),
        CONSTRAINT ck_revision_actor CHECK(actor IN ('user', 'agent', 'cli-external', 'system'))
      );
      INSERT INTO __rollback_revision (
        id, project_id, kind, path, entity, content_hash, parent_revision, actor, summary, created_at
      ) SELECT id, project_id, kind, path, entity, content_hash, parent_revision, actor, summary, created_at
      FROM revision;
      DROP TABLE revision;
      ALTER TABLE __rollback_revision RENAME TO revision;
      CREATE INDEX idx_revision_project_created ON revision(project_id, created_at);

      DROP TABLE revision_step;
      DROP TABLE mutation_step;
      DROP TABLE mcp_credential;
      DROP TABLE approval_grant;
      DROP TABLE backup_manifest;
      COMMIT;
    `);
  } catch (error) {
    try { client.exec("ROLLBACK"); } catch { /* SQLite already rolled back or closed the transaction. */ }
    throw error;
  } finally {
    client.exec("PRAGMA foreign_keys = ON");
  }

  const violation = client.prepare("SELECT count(*) AS count FROM pragma_foreign_key_check").get() as { count: number };
  if (violation.count !== 0) throw new Error(`MCP migration rollback left ${violation.count} foreign-key violations`);
}
