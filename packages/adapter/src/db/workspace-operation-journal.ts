import { sql } from "drizzle-orm";

import { ErrorCode, type ContentHash, type DomainError, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  parsePendingToolAudit,
  serializePendingToolAudit,
  type ClockPort,
  type MutationAuthority,
  type PendingWorkspaceOperation,
  type PendingToolAudit,
  type ProjectLifecycleCommit,
  type ResolvedPath,
  type WorkspaceOperationId,
  type WorkspaceOperationIntent,
  type WorkspaceOperationJournalPort,
  type WorkspaceOperationStepIntent,
  type WorkspaceOperationStepState,
} from "@vidcom/core";

import type { VidcomDatabase } from "./client";
import {
  LARGE_PREVIOUS_CONTENT_THRESHOLD,
  type PreviousContentStore,
} from "../fs/large-content-store";

function bytes(content: string | Uint8Array | null): Uint8Array | null {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function terminalAuditDetail(
  audit: PendingToolAudit,
  settledAt: string,
  extra: Record<string, unknown>,
): string {
  const invokedAt = Date.parse(audit.invokedAt);
  const terminalAt = Date.parse(settledAt);
  return canonicalizeJson({
    ...audit.detail,
    ...extra,
    credentialId: audit.credentialId,
    durationMs: Number.isFinite(invokedAt) && Number.isFinite(terminalAt)
      ? Math.max(0, terminalAt - invokedAt)
      : 0,
    era: audit.era,
    invocationId: audit.invocationId,
    level: audit.level,
    revisionAfter: null,
    revisionBefore: audit.revisionBefore,
  });
}

export class WorkspaceOperationTransactionError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceOperationTransactionError";
  }
}

/** SQLite operation journal for workspace batches and project-directory lifecycle. */
export class WorkspaceOperationJournal implements WorkspaceOperationJournalPort {
  constructor(
    private readonly database: VidcomDatabase,
    private readonly clock: ClockPort,
    private readonly previousContent?: PreviousContentStore,
  ) {}

  async isJournalOwned(invocationId: string): Promise<boolean> {
    return this.database.get<{ owned: number }>(sql`
      SELECT 1 AS owned FROM workspace_operation
      WHERE json_extract(tool_audit_json, '$.invocationId') = ${invocationId}
      LIMIT 1
    `) !== undefined;
  }

  private async prepare(content: string | Uint8Array | null) {
    const value = bytes(content);
    if (value === null) return { inline: null, objectHash: null, byteSize: 0 };
    if (!this.previousContent || value.byteLength <= LARGE_PREVIOUS_CONTENT_THRESHOLD) {
      return { inline: value, objectHash: null, byteSize: value.byteLength };
    }
    return {
      inline: null,
      objectHash: await this.previousContent.put(value),
      byteSize: value.byteLength,
    };
  }

  async begin(
    intent: WorkspaceOperationIntent,
    steps: WorkspaceOperationStepIntent[],
    authority: MutationAuthority,
  ): Promise<WorkspaceOperationId> {
    if (steps.some((step, ordinal) => step.ordinal !== ordinal)) {
      throw new TypeError("workspace operation steps must be ordered from ordinal zero");
    }
    if (new Set(steps.map(({ path }) => path)).size !== steps.length) {
      throw new TypeError("workspace operation paths must be unique");
    }
    const prepared = await Promise.all(steps.map((step) => this.prepare(step.previousContent)));
    const now = this.clock.now().toISOString();
    return this.database.transaction((transaction) => {
      const lease = transaction.get<{ leaseId: string }>(sql`
        UPDATE workspace_lease SET expires_at = expires_at
        WHERE workspace_root = ${intent.workspaceRoot}
          AND lease_id = ${authority.leaseId} AND expires_at >= ${now}
        RETURNING lease_id AS leaseId
      `);
      if (!lease) {
        throw new WorkspaceOperationTransactionError(
          ErrorCode.WorkspaceLeaseLost,
          "workspace lease was lost before operation begin",
        );
      }
      for (const step of steps) {
        const collision = transaction.get<{ id: number }>(sql`
          SELECT workspace_operation.id
          FROM workspace_operation
          INNER JOIN workspace_operation_step
            ON workspace_operation_step.operation_id = workspace_operation.id
          WHERE workspace_operation.workspace_root = ${intent.workspaceRoot}
            AND workspace_operation.status IN ('pending', 'orphaned')
            AND workspace_operation_step.path = ${step.path}
          LIMIT 1
        `);
        if (collision) {
          throw new WorkspaceOperationTransactionError(
            ErrorCode.WriteConflict,
            "another unresolved workspace operation owns this target",
          );
        }
      }
      const operation = transaction.get<{ id: number }>(sql`
        INSERT INTO workspace_operation (
          workspace_root, kind, project_id, from_path, to_path, staging_path,
          backup_id, grant_id, status, actor, action, tool_audit_json, created_at
        ) VALUES (
          ${intent.workspaceRoot}, ${intent.kind}, ${intent.projectId}, ${intent.fromPath},
          ${intent.toPath}, ${intent.stagingPath}, ${intent.backupId ?? null},
          ${intent.grantId ?? null}, 'pending', ${intent.actor}, ${intent.action},
          ${intent.toolAudit ? serializePendingToolAudit(intent.toolAudit) : null}, ${now}
        ) RETURNING id
      `);
      if (!operation) throw new Error("workspace operation insert returned no id");
      if (intent.grantId) {
        const reserved = transaction.run(sql`
          UPDATE approval_grant SET status = 'reserved', reserved_at = ${now}
          WHERE id = ${intent.grantId} AND status = 'issued' AND expires_at >= ${now}
        `);
        if (reserved.changes !== 1) {
          throw new WorkspaceOperationTransactionError(
            ErrorCode.ApprovalInvalid,
            "project deletion approval grant could not be reserved",
          );
        }
      }
      for (const step of steps) {
        const previous = prepared[step.ordinal]!;
        transaction.run(sql`
          INSERT INTO workspace_operation_step (
            operation_id, ordinal, path, from_hash, to_hash, previous_content,
            previous_object_hash, previous_byte_size
          ) VALUES (
            ${operation.id}, ${step.ordinal}, ${step.path}, ${step.fromHash}, ${step.toHash},
            ${previous.inline}, ${previous.objectHash}, ${previous.byteSize}
          )
        `);
      }
      return operation.id as WorkspaceOperationId;
    });
  }

  async markStepCaptured(
    id: WorkspaceOperationId,
    ordinal: number,
    rollbackPath: ResolvedPath | null,
    capturedHash: ContentHash | null,
  ): Promise<void> {
    const row = this.database.get<{ ordinal: number }>(sql`
      UPDATE workspace_operation_step
      SET rollback_path = ${rollbackPath}, captured_hash = ${capturedHash}, capture_state = 'captured'
      WHERE operation_id = ${id} AND ordinal = ${ordinal} AND capture_state = 'pending'
        AND captured_hash IS NULL
        AND from_hash IS ${capturedHash}
        AND EXISTS (
          SELECT 1 FROM workspace_operation
          WHERE workspace_operation.id = workspace_operation_step.operation_id
            AND workspace_operation.status = 'pending'
        )
      RETURNING ordinal
    `);
    if (!row) throw new Error("workspace operation capture transition was lost");
  }

  async markStepWritten(id: WorkspaceOperationId, ordinal: number): Promise<void> {
    const row = this.database.get<{ ordinal: number }>(sql`
      UPDATE workspace_operation_step SET status = 'written'
      WHERE operation_id = ${id} AND ordinal = ${ordinal} AND capture_state = 'captured'
      RETURNING ordinal
    `);
    if (!row) throw new Error("workspace operation write transition was lost");
  }

  private settleCommit(
    id: WorkspaceOperationId,
    sourceStatuses: readonly ("pending" | "orphaned")[],
    terminalStatus: "committed" | "recovered",
  ): void {
    const now = this.clock.now().toISOString();
    this.database.transaction((transaction) => {
      const operation = transaction.get<{
        projectId: string | null;
        kind: WorkspaceOperationIntent["kind"];
        actor: WorkspaceOperationIntent["actor"];
        action: string;
        toolAuditJson: string | null;
      }>(sql`
        SELECT project_id AS projectId, kind, actor, action, tool_audit_json AS toolAuditJson
        FROM workspace_operation WHERE id = ${id}
          AND status IN (${sourceStatuses[0]}, ${sourceStatuses[1] ?? sourceStatuses[0]})
      `);
      if (!operation) throw new Error("pending workspace operation was not found");
      const toolAudit = operation.toolAuditJson ? parsePendingToolAudit(operation.toolAuditJson) : null;
      const incomplete = transaction.get<{ ordinal: number }>(sql`
        SELECT ordinal FROM workspace_operation_step
        WHERE operation_id = ${id} AND status != 'written' LIMIT 1
      `);
      if (incomplete) throw new Error("workspace operation has an unwritten step");
      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${toolAudit?.projectId ?? (operation.kind === "agent_kit_files" || operation.kind === "project_create" ? null : operation.projectId)},
          ${toolAudit ? `tool:${toolAudit.tool}` : operation.action}, ${toolAudit ? "agent" : operation.actor}, NULL, NULL,
          ${toolAudit?.protocolVersion ?? null}, 'ok', NULL,
          ${toolAudit
            ? terminalAuditDetail(toolAudit, now, { operationId: id, recovered: terminalStatus === "recovered" })
            : JSON.stringify({ operationId: id, recovered: terminalStatus === "recovered" })}, ${now}
        )
      `);
      const settled = transaction.get<{ id: number }>(sql`
        UPDATE workspace_operation SET status = ${terminalStatus}, settled_at = ${now}
        WHERE id = ${id}
          AND status IN (${sourceStatuses[0]}, ${sourceStatuses[1] ?? sourceStatuses[0]})
        RETURNING id
      `);
      if (!settled) throw new Error("workspace operation commit transition was lost");
    });
  }

  async commit(id: WorkspaceOperationId): Promise<void> {
    this.settleCommit(id, ["pending"], "committed");
  }

  async setDirectoryPaths(
    id: WorkspaceOperationId,
    paths: { fromPath?: string | null; toPath?: string | null; stagingPath?: string | null },
  ): Promise<void> {
    const current = this.database.get<{ fromPath: string | null; toPath: string | null; stagingPath: string | null }>(sql`
      SELECT from_path AS fromPath, to_path AS toPath, staging_path AS stagingPath
      FROM workspace_operation WHERE id = ${id} AND status = 'pending'
    `);
    if (!current) throw new Error("pending workspace operation was not found");
    this.database.run(sql`
      UPDATE workspace_operation SET
        from_path = ${paths.fromPath === undefined ? current.fromPath : paths.fromPath},
        to_path = ${paths.toPath === undefined ? current.toPath : paths.toPath},
        staging_path = ${paths.stagingPath === undefined ? current.stagingPath : paths.stagingPath}
      WHERE id = ${id} AND status = 'pending'
    `);
  }

  async commitProjectLifecycle(
    id: WorkspaceOperationId,
    result: ProjectLifecycleCommit,
    recovered = false,
  ): Promise<number | null> {
    const now = result.occurredAt;
    return this.database.transaction((transaction) => {
      const operation = transaction.get<{
        kind: string; projectId: string | null; actor: string; backupId: string | null; grantId: string | null;
      }>(sql`
        SELECT kind, project_id AS projectId, actor, backup_id AS backupId, grant_id AS grantId
        FROM workspace_operation WHERE id = ${id} AND status IN ('pending', 'orphaned')
      `);
      const expectedKind = `project_${result.kind}`;
      if (!operation || operation.kind !== expectedKind || operation.projectId !== result.projectId
        || operation.actor !== result.actor) {
        throw new Error("workspace lifecycle operation does not match its terminal result");
      }
      const incomplete = transaction.get<{ ordinal: number }>(sql`
        SELECT ordinal FROM workspace_operation_step
        WHERE operation_id = ${id} AND status != 'written' LIMIT 1
      `);
      if (incomplete) throw new Error("workspace lifecycle operation has an unwritten step");

      let revisionId: number | null = null;
      if (result.kind === "create") {
        transaction.run(sql`
          INSERT INTO project_registry (
            id, workspace_root, slug, first_seen_at, last_seen_at, deleted_at
          ) VALUES (
            ${result.projectId}, ${result.workspaceRoot}, ${result.slug}, ${now}, ${now}, NULL
          )
        `);
        const revision = transaction.get<{ id: number }>(sql`
          INSERT INTO revision (
            project_id, kind, path, entity, content_hash, parent_revision,
            actor, summary, advances_source, created_at
          ) VALUES (
            ${result.projectId}, 'composite', NULL, NULL, ${result.manifestHash}, NULL,
            ${result.actor}, 'project.create', 1, ${now}
          ) RETURNING id
        `);
        if (!revision) throw new Error("project create revision was not inserted");
        revisionId = revision.id;
        const steps = transaction.all<{
          ordinal: number; path: string; fromHash: string | null; toHash: string | null;
        }>(sql`
          SELECT ordinal, path, from_hash AS fromHash, to_hash AS toHash
          FROM workspace_operation_step WHERE operation_id = ${id} ORDER BY ordinal
        `);
        for (const step of steps) transaction.run(sql`
          INSERT INTO revision_step (
            revision_id, ordinal, kind, path, entity, from_hash, to_hash,
            previous_content, previous_object_hash, byte_size, backup_id
          ) VALUES (
            ${revision.id}, ${step.ordinal}, 'write', ${step.path}, NULL,
            ${step.fromHash}, ${step.toHash}, NULL, NULL, 0, NULL
          )
        `);
        transaction.run(sql`
          INSERT INTO entity_state (
            project_id, entity, revision, content_hash, backing_path, last_actor, updated_at
          ) VALUES (
            ${result.projectId}, 'preview-settings', 1, ${result.previewSettingsHash},
            'preview-settings.json', ${result.actor}, ${now}
          )
        `);
      } else if (result.kind === "rename") {
        if (result.projectId !== null) {
          const updated = transaction.run(sql`
            UPDATE project_registry SET slug = ${result.toSlug}, last_seen_at = ${now}
            WHERE id = ${result.projectId} AND workspace_root = ${result.workspaceRoot}
              AND slug = ${result.fromSlug} AND deleted_at IS NULL
          `);
          if (updated.changes !== 1) throw new Error("active project registration was not renamed");
        }
      } else {
        if (operation.backupId !== result.backupId) throw new Error("verified backup does not match delete operation");
        if (result.projectId !== null) {
          const updated = transaction.run(sql`
            UPDATE project_registry SET deleted_at = ${now}, last_seen_at = ${now}
            WHERE id = ${result.projectId} AND workspace_root = ${result.workspaceRoot}
              AND slug = ${result.slug} AND deleted_at IS NULL
          `);
          if (updated.changes !== 1) throw new Error("active project registration was not removed");
        }
      }

      if (result.kind === "delete" && operation.grantId) {
        const consumed = transaction.run(sql`
          UPDATE approval_grant SET status = 'consumed', consumed_at = ${now}
          WHERE id = ${operation.grantId} AND status = 'reserved'
        `);
        if (consumed.changes !== 1) throw new Error("reserved project deletion grant was not consumed");
      }

      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${result.projectId}, ${`project.${result.kind}`}, ${result.actor}, ${revisionId}, NULL, NULL,
          'ok', NULL, ${JSON.stringify({ operationId: id, recovered, ...(result.kind === "delete" ? { backupId: result.backupId } : {}) })}, ${now}
        )
      `);
      transaction.run(result.projectId === null ? sql`
        INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('workspace.changed', NULL, ${JSON.stringify({ operation: result.kind, slug: result.kind === "rename" ? result.toSlug : result.slug })}, ${now})
      ` : sql`
        INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES ('project.changed', ${result.projectId}, ${JSON.stringify({ operation: result.kind })}, ${now})
      `);
      const terminal = recovered ? "recovered" : "committed";
      const settled = transaction.run(sql`
        UPDATE workspace_operation SET status = ${terminal}, settled_at = ${now}
        WHERE id = ${id} AND status IN ('pending', 'orphaned')
      `);
      if (settled.changes !== 1) throw new Error("workspace lifecycle terminal transition was lost");
      return revisionId;
    });
  }

  async recover(id: WorkspaceOperationId): Promise<void> {
    this.settleCommit(id, ["pending", "orphaned"], "recovered");
  }

  async completeDirectoryCleanup(id: WorkspaceOperationId): Promise<void> {
    const completed = this.database.run(sql`
      UPDATE workspace_operation SET staging_path = NULL
      WHERE id = ${id} AND kind = 'project_delete'
        AND status IN ('committed', 'recovered') AND staging_path IS NOT NULL
    `);
    if (completed.changes !== 1) throw new Error("project directory cleanup obligation was not found");
  }

  private settleFailure(
    id: WorkspaceOperationId,
    status: "aborted" | "recovered" | "orphaned",
    reason: ErrorCode,
  ): void {
    const now = this.clock.now().toISOString();
    this.database.transaction((transaction) => {
      const operation = transaction.get<{
        projectId: string | null;
        kind: WorkspaceOperationIntent["kind"];
        actor: WorkspaceOperationIntent["actor"];
        action: string;
        grantId: string | null;
        toolAuditJson: string | null;
      }>(sql`
        SELECT project_id AS projectId, kind, actor, action, grant_id AS grantId,
          tool_audit_json AS toolAuditJson FROM workspace_operation
        WHERE id = ${id} AND status IN ('pending', 'orphaned')
      `);
      if (!operation) throw new Error("unresolved workspace operation was not found");
      const toolAudit = operation.toolAuditJson ? parsePendingToolAudit(operation.toolAuditJson) : null;
      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, protocol_version, outcome, error_code, detail, created_at
        ) VALUES (
          ${toolAudit?.projectId ?? (operation.kind === "agent_kit_files" || operation.kind === "project_create" ? null : operation.projectId)},
          ${toolAudit ? `tool:${toolAudit.tool}` : operation.action}, ${toolAudit ? "agent" : operation.actor},
          ${toolAudit?.protocolVersion ?? null}, 'error', ${reason},
          ${toolAudit
            ? terminalAuditDetail(toolAudit, now, { operationId: id, terminal: status })
            : JSON.stringify({ operationId: id, terminal: status })}, ${now}
        )
      `);
      if (status === "recovered") {
        transaction.run(sql`
          UPDATE workspace_operation_step SET status = 'rolled_back'
          WHERE operation_id = ${id} AND capture_state = 'captured'
        `);
      }
      if (operation.grantId) {
        if (status === "orphaned") transaction.run(sql`
          UPDATE approval_grant SET status = 'invalidated', invalidated_at = ${now}, invalidated_reason = 'orphaned'
          WHERE id = ${operation.grantId} AND status = 'reserved'
        `);
        else transaction.run(sql`
          UPDATE approval_grant SET status = CASE WHEN expires_at < ${now} THEN 'expired' ELSE 'issued' END,
            reserved_at = NULL
          WHERE id = ${operation.grantId} AND status = 'reserved'
        `);
      }
      transaction.run(sql`
        UPDATE workspace_operation SET status = ${status},
          settled_at = ${status === "orphaned" ? null : now}
        WHERE id = ${id}
      `);
    });
  }

  async abort(id: WorkspaceOperationId, reason: ErrorCode): Promise<void> {
    this.settleFailure(id, "aborted", reason);
  }

  async rollback(id: WorkspaceOperationId, reason: ErrorCode): Promise<void> {
    this.settleFailure(id, "recovered", reason);
  }

  async orphan(id: WorkspaceOperationId, reason: ErrorCode): Promise<void> {
    this.settleFailure(id, "orphaned", reason);
  }

  async read(id: WorkspaceOperationId): Promise<PendingWorkspaceOperation | null> {
    const operation = this.database.get<Omit<PendingWorkspaceOperation, "id" | "steps">>(sql`
      SELECT workspace_root AS workspaceRoot, kind, project_id AS projectId,
        from_path AS fromPath, to_path AS toPath, staging_path AS stagingPath,
        backup_id AS backupId, actor, action, status
      FROM workspace_operation WHERE id = ${id} AND (
        status IN ('pending', 'orphaned')
        OR (kind = 'project_delete' AND status IN ('committed', 'recovered') AND staging_path IS NOT NULL)
      )
    `);
    if (!operation) return null;
    const rows = this.database.all<{
      ordinal: number; path: string; fromHash: string | null; toHash: string | null;
      previousContent: Uint8Array | null; previousObjectHash: string | null;
      rollbackPath: string | null; capturedHash: string | null;
      captureState: WorkspaceOperationStepState["captureState"];
      status: WorkspaceOperationStepState["status"];
    }>(sql`
      SELECT ordinal, path, from_hash AS fromHash, to_hash AS toHash,
        previous_content AS previousContent, previous_object_hash AS previousObjectHash,
        rollback_path AS rollbackPath, captured_hash AS capturedHash,
        capture_state AS captureState, status
      FROM workspace_operation_step WHERE operation_id = ${id} ORDER BY ordinal
    `);
    const steps = await Promise.all(rows.map(async (row): Promise<WorkspaceOperationStepState> => ({
      ordinal: row.ordinal,
      path: row.path as RelPath,
      fromHash: row.fromHash as ContentHash | null,
      toHash: row.toHash as ContentHash | null,
      previousContent: row.previousContent ?? (row.previousObjectHash && this.previousContent
        ? await this.previousContent.read(row.previousObjectHash as ContentHash)
        : null),
      rollbackPath: row.rollbackPath as ResolvedPath | null,
      capturedHash: row.capturedHash as ContentHash | null,
      captureState: row.captureState,
      status: row.status,
    })));
    return { id, ...operation, steps } as PendingWorkspaceOperation;
  }

  async listPending(workspaceRoot: WorkspaceOperationIntent["workspaceRoot"]): Promise<PendingWorkspaceOperation[]> {
    const rows = this.database.all<{ id: number }>(sql`
      SELECT id FROM workspace_operation
      WHERE workspace_root = ${workspaceRoot} AND (
        status IN ('pending', 'orphaned')
        OR (kind = 'project_delete' AND status IN ('committed', 'recovered') AND staging_path IS NOT NULL)
      )
      ORDER BY created_at, id
    `);
    return (await Promise.all(rows.map(({ id }) => this.read(id as WorkspaceOperationId))))
      .filter((value): value is PendingWorkspaceOperation => value !== null);
  }
}

export function workspaceOperationError(error: unknown): DomainError {
  if (error instanceof WorkspaceOperationTransactionError) {
    return { code: error.code, message: error.message };
  }
  return { code: ErrorCode.StorageUnavailable, message: "workspace operation storage failed" };
}
