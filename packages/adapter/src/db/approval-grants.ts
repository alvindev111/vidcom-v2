import { sql } from "drizzle-orm";

import {
  canonicalizeJson,
  type ApprovalGrantPort,
  type ApprovalGrantRecord,
  type GrantBinding,
} from "@vidcom/core";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";

import type { VidcomDatabase } from "./client";

interface StoredGrant {
  id: string;
  projectId: string;
  tool: string;
  target: string;
  expectedRevision: number;
  planDigest: string;
  targetHashes: string;
  summary: string;
  status: ApprovalGrantRecord["status"];
  approver: ApprovalGrantRecord["approver"];
  createdAt: string;
  expiresAt: string;
}

function record(row: StoredGrant): ApprovalGrantRecord {
  return {
    id: row.id,
    binding: {
      tool: row.tool,
      projectId: row.projectId as ProjectId,
      target: row.target,
      expectedRevision: row.expectedRevision,
      planDigest: row.planDigest,
      targetHashes: JSON.parse(row.targetHashes) as Record<RelPath, ContentHash>,
    },
    summary: row.summary,
    status: row.status,
    approver: row.approver,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

const selectGrant = sql`
  SELECT id, project_id AS projectId, tool, target, expected_revision AS expectedRevision,
    plan_digest AS planDigest, target_hashes AS targetHashes, summary, status, approver,
    created_at AS createdAt, expires_at AS expiresAt
  FROM approval_grant
`;

/** SQLite approval repository; reserve/finalize transitions remain owned by MutationJournal. */
export class SqliteApprovalGrantStore implements ApprovalGrantPort {
  constructor(private readonly database: VidcomDatabase) {}

  async create(item: ApprovalGrantRecord): Promise<void> {
    this.database.run(sql`
      INSERT INTO approval_grant (
        id, project_id, tool, target, expected_revision, plan_digest, target_hashes,
        summary, status, approver, created_at, expires_at
      ) VALUES (
        ${item.id}, ${item.binding.projectId}, ${item.binding.tool}, ${item.binding.target},
        ${item.binding.expectedRevision}, ${item.binding.planDigest},
        ${canonicalizeJson(item.binding.targetHashes)}, ${item.summary}, ${item.status},
        ${item.approver}, ${item.createdAt}, ${item.expiresAt}
      )
    `);
  }

  async read(id: string): Promise<ApprovalGrantRecord | null> {
    const row = this.database.get<StoredGrant>(sql`${selectGrant} WHERE id = ${id}`);
    return row ? record(row) : null;
  }

  async issue(
    id: string,
    approver: "ui" | "cli",
    issuedAt: string,
    expiresAt: string,
  ): Promise<ApprovalGrantRecord | null> {
    const issued = this.database.transaction((transaction) => {
      transaction.run(sql`
        UPDATE approval_grant SET status = 'expired'
        WHERE id = ${id} AND status = 'requested' AND expires_at <= ${issuedAt}
      `);
      const transitioned = transaction.get<{ id: string }>(sql`
        UPDATE approval_grant SET status = 'issued', approver = ${approver},
          issued_at = ${issuedAt}, expires_at = ${expiresAt}
        WHERE id = ${id} AND status = 'requested' AND expires_at > ${issuedAt}
        RETURNING id
      `);
      if (!transitioned) return null;
      const row = transaction.get<StoredGrant>(sql`${selectGrant} WHERE id = ${id}`);
      return row ? record(row) : null;
    });
    return issued;
  }

  async revoke(id: string): Promise<boolean> {
    return this.database.get<{ id: string }>(sql`
      UPDATE approval_grant SET status = 'revoked'
      WHERE id = ${id} AND status = 'issued' RETURNING id
    `) !== undefined;
  }

  async matches(id: string, binding: GrantBinding, now: string): Promise<boolean> {
    return this.database.get<{ id: string }>(sql`
      SELECT id FROM approval_grant
      WHERE id = ${id} AND status = 'issued' AND expires_at > ${now}
        AND tool = ${binding.tool} AND project_id = ${binding.projectId}
        AND target = ${binding.target} AND expected_revision = ${binding.expectedRevision}
        AND plan_digest = ${binding.planDigest}
        AND target_hashes = ${canonicalizeJson(binding.targetHashes)}
    `) !== undefined;
  }

  async cleanupTerminal(expiresBefore: string): Promise<number> {
    const result = this.database.run(sql`
      DELETE FROM approval_grant
      WHERE status IN ('consumed', 'expired', 'revoked', 'invalidated')
        AND expires_at < ${expiresBefore}
        AND NOT EXISTS (
          SELECT 1 FROM mutation_journal
          WHERE mutation_journal.grant_id = approval_grant.id
            AND mutation_journal.status IN ('pending', 'orphaned')
        )
    `);
    return Number(result.changes);
  }
}
