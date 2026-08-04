import { sql } from "drizzle-orm";

import type { VidcomDatabase } from "./client";

/** Current SQLite persistence invariants used by startup diagnostics and integration tests. */
export interface DatabaseHealth {
  integrity: string;
  journalMode: string;
  foreignKeyViolations: number;
  foreignKeys: string[];
  tables: string[];
}

const APPLICATION_TABLES = [
  "project_registry", "workspace_lease", "mutation_journal", "entity_state",
  "event_outbox", "revision", "revision_blob", "job", "audit_entry",
  "app_settings", "registry_cache", "approval_grant", "backup_manifest",
  "mcp_credential", "mutation_step", "revision_step",
  "workspace_operation", "workspace_operation_step",
] as const;

/** Reads SQLite health through the native client owned by Drizzle. */
export async function inspectDatabase(database: VidcomDatabase): Promise<DatabaseHealth> {
  const integrity = database.get<{ integrity_check?: string }>(sql`PRAGMA integrity_check`);
  const journal = database.get<{ journal_mode?: string }>(sql`PRAGMA journal_mode`);
  const violations = database.all(sql`PRAGMA foreign_key_check`);
  const tables = database.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).map((table) => table.name);
  const foreignKeys: string[] = [];
  for (const table of APPLICATION_TABLES) {
    const definitions = database.all<{ table: string; from: string; to: string }>(
      sql.raw(`PRAGMA foreign_key_list(${JSON.stringify(table)})`),
    );
    for (const definition of definitions) foreignKeys.push(`${table}.${definition.from}->${definition.table}.${definition.to}`);
  }
  return {
    integrity: integrity?.integrity_check ?? "missing",
    journalMode: journal?.journal_mode ?? "missing",
    foreignKeyViolations: violations.length,
    foreignKeys: foreignKeys.sort(),
    tables,
  };
}
