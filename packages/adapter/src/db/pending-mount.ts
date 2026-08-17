import { sql } from "drizzle-orm";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import type {
  ClockPort,
  PendingMount,
  PendingMountFailure,
  PendingMountPort,
} from "@vidcom/core";

import type { VidcomDatabase } from "./client";
import { JournalTransactionError } from "./journal";

interface PendingMountRow {
  operationId: string;
  projectId: string;
  assetPath: string;
  assetContentHash: string;
  uploadFingerprint: string;
  atSeconds: number;
  trackIndex: number;
  state: "uploaded_unmounted" | "mounted" | "abandoned";
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  mountedSceneId: string | null;
  mountedRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

const PENDING_MOUNT_COLUMNS = sql`
  operation_id AS operationId, project_id AS projectId, asset_path AS assetPath,
  asset_content_hash AS assetContentHash, upload_fingerprint AS uploadFingerprint,
  at_seconds AS atSeconds, track_index AS trackIndex, state,
  last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage,
  mounted_scene_id AS mountedSceneId, mounted_revision AS mountedRevision,
  created_at AS createdAt, updated_at AS updatedAt
`;

function toPendingMount(row: PendingMountRow): PendingMount {
  return {
    operationId: row.operationId,
    projectId: row.projectId as ProjectId,
    assetPath: row.assetPath as RelPath,
    assetContentHash: row.assetContentHash as ContentHash,
    uploadFingerprint: row.uploadFingerprint as ContentHash,
    atSeconds: row.atSeconds,
    trackIndex: row.trackIndex,
    state: row.state,
    lastFailure: row.lastErrorCode === null
      ? null
      : { code: row.lastErrorCode, message: row.lastErrorMessage! },
    mountedSceneId: row.mountedSceneId,
    mountedRevision: row.mountedRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** SQLite query/status adapter; journal settlement exclusively owns open/close/reopen. */
export class SqlitePendingMountStore implements PendingMountPort {
  constructor(
    private readonly database: VidcomDatabase,
    private readonly clock: ClockPort,
  ) {}

  async lookup(projectId: ProjectId, operationId: string): Promise<
    | { state: "active"; record: PendingMount }
    | { state: "expired" }
    | { state: "never-seen" }
  > {
    const row = this.database.get<PendingMountRow>(sql`
      SELECT ${PENDING_MOUNT_COLUMNS} FROM pending_mount
      WHERE operation_id = ${operationId} AND project_id = ${projectId}
    `);
    if (row) return { state: "active", record: toPendingMount(row) };
    const historicalOpen = this.database.get<{ seen: number }>(sql`
      SELECT 1 AS seen FROM mutation_journal
      WHERE project_id = ${projectId}
        AND json_extract(pending_transition, '$.operationId') = ${operationId}
        AND json_extract(pending_transition, '$.kind') = 'open'
      LIMIT 1
    `);
    return historicalOpen ? { state: "expired" } : { state: "never-seen" };
  }

  async listPending(projectId: ProjectId): Promise<Array<PendingMount & { state: "uploaded_unmounted" }>> {
    const rows = this.database.all<PendingMountRow>(sql`
      SELECT ${PENDING_MOUNT_COLUMNS} FROM pending_mount
      WHERE project_id = ${projectId} AND state = 'uploaded_unmounted'
      ORDER BY updated_at, operation_id
    `);
    return rows.map((row) => toPendingMount(row) as PendingMount & { state: "uploaded_unmounted" });
  }

  async markFailed(projectId: ProjectId, operationId: string, failure: PendingMountFailure): Promise<void> {
    const now = this.clock.now().toISOString();
    const updated = this.database.run(sql`
      UPDATE pending_mount SET last_error_code = ${failure.code}, last_error_message = ${failure.message},
        updated_at = ${now}
      WHERE operation_id = ${operationId} AND project_id = ${projectId}
        AND state = 'uploaded_unmounted'
    `);
    if (updated.changes !== 1) {
      throw new JournalTransactionError(ErrorCode.WriteConflict, "pending mount can no longer be marked failed");
    }
  }

  async abandon(projectId: ProjectId, operationId: string, reason: string): Promise<void> {
    const now = this.clock.now().toISOString();
    const updated = this.database.run(sql`
      UPDATE pending_mount SET state = 'abandoned', last_error_code = 'abandoned',
        last_error_message = ${reason}, updated_at = ${now}
      WHERE operation_id = ${operationId} AND project_id = ${projectId}
        AND state = 'uploaded_unmounted'
    `);
    if (updated.changes === 1) return;
    const existing = this.database.get<{ state: string; projectId: string }>(sql`
      SELECT state, project_id AS projectId FROM pending_mount WHERE operation_id = ${operationId}
    `);
    if (existing?.projectId === projectId && existing.state === "abandoned") return;
    throw new JournalTransactionError(ErrorCode.WriteConflict, "pending mount can no longer be abandoned");
  }
}
