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

/**
 * Retention windows from Design §5.21. A mounted row is the idempotency record
 * for one drop: it must outlive a lost response long enough for the browser to
 * retry, and no longer. An upload nobody ever mounted is abandoned rather than
 * deleted, so the file in Media keeps an explanation attached to it.
 */
export const PENDING_MOUNT_UNMOUNTED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PENDING_MOUNT_MOUNTED_TOMBSTONE_MS = 24 * 60 * 60 * 1_000;
export const PENDING_MOUNT_ABANDONED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Startup-only retention sweep.
 *
 * It runs once at boot, after the previous daemon's history is gone: no live undo
 * receipt of this daemon can reference a row it deletes. Deleting a row never
 * loses the operation — the journal keeps the open transition, so a late retry
 * reads `expired` and is refused instead of opening a second upload under an id
 * that already produced a scene.
 */
export async function sweepPendingMounts(
  database: VidcomDatabase,
  now: Date,
): Promise<{ abandoned: number; deleted: number; interrupted: number }> {
  const moment = now.toISOString();
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const abandoned = database.run(sql`
    UPDATE pending_mount SET state = 'abandoned', last_error_code = 'abandoned',
      last_error_message = 'this upload was never mounted and has expired', updated_at = ${moment}
    WHERE state = 'uploaded_unmounted' AND created_at <= ${before(PENDING_MOUNT_UNMOUNTED_TTL_MS)}
  `).changes;
  const deleted = database.run(sql`
    DELETE FROM pending_mount
    WHERE (state = 'mounted' AND updated_at <= ${before(PENDING_MOUNT_MOUNTED_TOMBSTONE_MS)})
       OR (state = 'abandoned' AND updated_at <= ${before(PENDING_MOUNT_ABANDONED_TTL_MS)})
  `).changes;
  // A row that survived a killed daemon has no reason recorded against it. Saying
  // "interrupted" is the difference between Media explaining the file and Media
  // showing an unexplained one (R11.3b).
  const interrupted = database.run(sql`
    UPDATE pending_mount SET last_error_code = 'interrupted',
      last_error_message = 'the mount was interrupted before it finished'
    WHERE state = 'uploaded_unmounted' AND last_error_code IS NULL
  `).changes;
  return { abandoned: Number(abandoned), deleted: Number(deleted), interrupted: Number(interrupted) };
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
