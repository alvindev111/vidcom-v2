import type { ToolAuditEntry, ToolAuditPort } from "@vidcom/core";
import { canonicalizeJson, redactAuditDetail } from "@vidcom/core";

import type { VidcomDatabase } from "./client";
import { auditEntry } from "./schema";

/** SQLite app-data repository for terminal tool rows that are not owned by a mutation journal. */
export class SqliteToolAuditRepository implements ToolAuditPort {
  constructor(private readonly database: VidcomDatabase) {}

  async record(entry: ToolAuditEntry, createdAt: string): Promise<void> {
    this.database.insert(auditEntry).values({
      projectId: entry.projectId,
      action: `tool:${entry.tool}`,
      actor: "agent",
      revisionId: null,
      jobId: null,
      protocolVersion: entry.protocolVersion,
      outcome: entry.outcome,
      errorCode: entry.errorCode,
      detail: canonicalizeJson({
        ...redactAuditDetail(entry.detail),
        credentialId: entry.credentialId,
        durationMs: entry.durationMs,
        era: entry.era,
        level: entry.level,
        revisionAfter: entry.revisionAfter,
        revisionBefore: entry.revisionBefore,
      }),
      createdAt,
    }).run();
  }
}
