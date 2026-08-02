import { sql } from "drizzle-orm";

import type { ContentHash } from "@vidcom/contracts";
import type { McpCredentialPort, McpCredentialRecord } from "@vidcom/core";

import type { VidcomDatabase } from "./client";

interface StoredCredential {
  id: string;
  label: string;
  secretHash: string;
  status: McpCredentialRecord["status"];
  createdAt: string;
  rotatedFrom: string | null;
  expiresAt: string | null;
}

function record(row: StoredCredential): McpCredentialRecord {
  return { ...row, secretHash: row.secretHash as ContentHash };
}

const selectCredential = sql`
  SELECT id, label, secret_hash AS secretHash, status, created_at AS createdAt,
    rotated_from AS rotatedFrom, expires_at AS expiresAt
  FROM mcp_credential
`;

/** SQLite repository for MCP credential hashes and lifecycle metadata only. */
export class SqliteMcpCredentialStore implements McpCredentialPort {
  constructor(private readonly database: VidcomDatabase) {}

  async create(item: McpCredentialRecord): Promise<void> {
    this.database.run(sql`
      INSERT INTO mcp_credential (
        id, label, secret_hash, status, created_at, rotated_from, expires_at
      ) VALUES (
        ${item.id}, ${item.label}, ${item.secretHash}, ${item.status}, ${item.createdAt},
        ${item.rotatedFrom}, ${item.expiresAt}
      )
    `);
  }

  async findUsableByHash(secretHash: ContentHash, now: string): Promise<McpCredentialRecord | null> {
    const row = this.database.transaction((transaction) => {
      transaction.run(sql`
        UPDATE mcp_credential SET status = 'revoked'
        WHERE status = 'rotating' AND expires_at <= ${now}
      `);
      return transaction.get<StoredCredential>(sql`
        ${selectCredential}
        WHERE secret_hash = ${secretHash}
          AND (status = 'active' OR (status = 'rotating' AND expires_at > ${now}))
      `);
    });
    return row ? record(row) : null;
  }

  async read(id: string): Promise<McpCredentialRecord | null> {
    const row = this.database.get<StoredCredential>(sql`${selectCredential} WHERE id = ${id}`);
    return row ? record(row) : null;
  }

  async list(): Promise<McpCredentialRecord[]> {
    return this.database.all<StoredCredential>(sql`
      ${selectCredential} ORDER BY created_at, id
    `).map(record);
  }

  async rotate(
    currentId: string,
    replacement: McpCredentialRecord,
    expiresAt: string,
  ): Promise<boolean> {
    return this.database.transaction((transaction) => {
      const current = transaction.get<{ id: string }>(sql`
        UPDATE mcp_credential SET status = 'rotating', expires_at = ${expiresAt}
        WHERE id = ${currentId} AND status = 'active' RETURNING id
      `);
      if (!current) return false;
      transaction.run(sql`
        INSERT INTO mcp_credential (
          id, label, secret_hash, status, created_at, rotated_from, expires_at
        ) VALUES (
          ${replacement.id}, ${replacement.label}, ${replacement.secretHash}, ${replacement.status},
          ${replacement.createdAt}, ${replacement.rotatedFrom}, ${replacement.expiresAt}
        )
      `);
      return true;
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.database.get<{ id: string }>(sql`
      UPDATE mcp_credential SET status = 'revoked', expires_at = NULL
      WHERE id = ${id} AND status IN ('active', 'rotating') RETURNING id
    `) !== undefined;
  }
}
