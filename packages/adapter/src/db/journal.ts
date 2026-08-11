import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { ErrorCode, type Actor, type ContentHash, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  err,
  ok,
  parsePendingToolAudit,
  serializePendingToolAudit,
  type AbsolutePath,
  type CompositeIntent,
  type CompositeMutationJournalPort,
  type CompositeResult,
  type ClockPort,
  type EntitySeed,
  type EntityState,
  type Result,
  type JournalId,
  type MutationIntent,
  type MutationJournalPort,
  type MutationResult,
  type MutationAuthority,
  type PendingMutation,
  type ProjectRegistration,
  type ProjectRevisionProjection,
  type GrantTransition,
  type PendingMutationContext,
  type PendingCompositeMutation,
  type PendingToolAudit,
  type PendingCommandAudit,
  type StepIntent,
  type ProjectRecoveryStatus,
  type ResolvedPath,
  type WriteEnvelope,
} from "@vidcom/core";

import type { VidcomDatabase } from "./client";
import {
  LARGE_PREVIOUS_CONTENT_THRESHOLD,
  type PreviousContentStore,
} from "../fs/large-content-store";

export const DERIVED_ROLLBACK_GENERATIONS = 3;

function contentBytes(content: string | Uint8Array | null): Uint8Array | null {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** Predictable T1 failure carrying the domain code later mapped by WriteAuthority. */
export class JournalTransactionError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "JournalTransactionError";
  }
}

function assertOrderedSteps(steps: StepIntent[]): void {
  if (steps.length === 0 || steps.some((step, index) => step.ordinal !== index)) {
    throw new TypeError("composite mutation steps must be non-empty and ordered from ordinal zero");
  }
}

function compositeManifestHash(steps: StepIntent[]): ContentHash {
  const manifest = steps.map(({ ordinal, kind, path, entity, toHash }) => ({
    ordinal,
    kind,
    path,
    entity,
    toHash,
  }));
  return `sha256:${createHash("sha256").update(canonicalizeJson(manifest)).digest("hex")}` as ContentHash;
}

function isDerivedPath(path: RelPath | null): boolean {
  return path !== null && (
    path.startsWith(".vidcom/")
    || path.startsWith("snapshots/")
    || path.startsWith("renders/")
  );
}

function isDerivedComposite(result: CompositeResult): boolean {
  return result.steps.length > 0
    && result.steps.every((step) => step.kind === "write" && isDerivedPath(step.path));
}

interface StoredStepRow {
  ordinal: number;
  kind: "write" | "delete" | "entity";
  path: string | null;
  entity: "preview-settings" | null;
  fromHash: string | null;
  toHash: string | null;
  previousContent: Uint8Array | null;
  previousObjectHash: string | null;
}

function storedStepIntent(row: StoredStepRow, previousContent: Uint8Array | null): StepIntent {
  const common = {
    ordinal: row.ordinal,
    fromHash: row.fromHash as ContentHash | null,
    previousContent,
  };
  if (row.kind === "entity" && row.entity && row.toHash) {
    return {
      ...common,
      kind: "entity",
      path: null,
      entity: row.entity,
      toHash: row.toHash as ContentHash,
    };
  }
  if (row.kind === "delete" && row.path) {
    return {
      ...common,
      kind: "delete",
      path: row.path as RelPath,
      entity: null,
      toHash: null,
    };
  }
  if (row.kind === "write" && row.path && row.toHash) {
    return {
      ...common,
      kind: "write",
      path: row.path as RelPath,
      entity: null,
      toHash: row.toHash as ContentHash,
    };
  }
  throw new Error("stored mutation step violates its canonical shape");
}

function storedMutationContext(value: string | null): PendingMutationContext {
  if (value === null) return { toolAudit: null };
  const parsed = JSON.parse(value) as PendingToolAudit | PendingCommandAudit;
  return "action" in parsed
    ? { toolAudit: null, commandAudit: parsed }
    : { toolAudit: parsePendingToolAudit(value) };
}

function terminalToolAuditDetail(
  audit: PendingToolAudit | null,
  settledAt: string,
  revisionAfter: number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!audit) return extra;
  const invokedAt = Date.parse(audit.invokedAt);
  const terminalAt = Date.parse(settledAt);
  return {
    ...audit.detail,
    ...extra,
    credentialId: audit.credentialId,
    durationMs: Number.isFinite(invokedAt) && Number.isFinite(terminalAt)
      ? Math.max(0, terminalAt - invokedAt)
      : 0,
    era: audit.era,
    invocationId: audit.invocationId,
    level: audit.level,
    revisionAfter,
    revisionBefore: audit.revisionBefore,
  };
}

/** Drizzle-backed mutation unit-of-work spanning journal, revision, audit and event rows. */
export class MutationJournal implements MutationJournalPort, CompositeMutationJournalPort {
  constructor(
    private readonly database: VidcomDatabase,
    private readonly clock: ClockPort,
    private readonly largeContent?: PreviousContentStore,
  ) {}

  private async preparePrevious(content: string | Uint8Array | null) {
    const bytes = contentBytes(content);
    if (bytes === null) return { inline: null, objectHash: null, byteSize: 0 };
    if (!this.largeContent || bytes.byteLength <= LARGE_PREVIOUS_CONTENT_THRESHOLD) {
      return { inline: bytes, objectHash: null, byteSize: bytes.byteLength };
    }
    return {
      inline: null,
      objectHash: await this.largeContent.put(bytes),
      byteSize: bytes.byteLength,
    };
  }

  private async hydratePrevious(row: StoredStepRow): Promise<Uint8Array | null> {
    return this.hydrateContent(row.previousContent, row.previousObjectHash);
  }

  private async hydrateContent(
    previousContent: Uint8Array | null,
    previousObjectHash: string | null,
  ): Promise<Uint8Array | null> {
    if (previousContent !== null) return previousContent;
    if (previousObjectHash === null) return null;
    if (!this.largeContent) throw new Error("large previous-content storage is unavailable");
    return this.largeContent.read(previousObjectHash as ContentHash);
  }

  /** Persists the composite journal, ordered steps, durable audit context and optional grant reserve atomically. */
  async beginComposite(
    intent: CompositeIntent,
    steps: StepIntent[],
    context: PendingMutationContext,
    authority: MutationAuthority,
    grant?: Extract<GrantTransition, { kind: "reserve" }>,
  ): Promise<JournalId> {
    assertOrderedSteps(steps);
    const preparedSteps = await Promise.all(steps.map((step) => this.preparePrevious(step.previousContent)));
    const now = this.clock.now().toISOString();
    if (context.toolAudit && context.commandAudit) {
      throw new TypeError("a composite mutation cannot own both tool and command audit context");
    }
    const durableToolAudit = context.toolAudit === null
      ? null
      : {
          ...context.toolAudit,
          detail: grant
            ? { ...context.toolAudit.detail, grantId: grant.grantId }
            : context.toolAudit.detail,
        };
    const auditJson = context.commandAudit
      ? canonicalizeJson(context.commandAudit)
      : durableToolAudit === null ? null : serializePendingToolAudit(durableToolAudit);
    const outcome = this.database.transaction((transaction): JournalId | { error: JournalTransactionError } => {
      const lease = transaction.get<{ leaseId: string }>(sql`
        UPDATE workspace_lease SET expires_at = expires_at
        WHERE lease_id = ${authority.leaseId} AND expires_at >= ${now}
          AND workspace_root = (
            SELECT workspace_root FROM project_registry WHERE id = ${intent.projectId} AND deleted_at IS NULL
          )
        RETURNING lease_id AS leaseId
      `);
      if (!lease) {
        throw new JournalTransactionError(
          ErrorCode.WorkspaceLeaseLost,
          "workspace lease was lost before the mutation journal transaction",
        );
      }
      const unresolved = transaction.get<{ id: number }>(sql`
        SELECT id FROM mutation_journal
        WHERE project_id = ${intent.projectId} AND status IN ('pending', 'orphaned')
        ORDER BY id LIMIT 1
      `);
      if (unresolved) {
        throw new JournalTransactionError(
          ErrorCode.RecoveryRequired,
          "the project has an unresolved mutation at journal begin",
        );
      }
      if (grant) {
        const row = transaction.get<{
          status: string;
          tool: string;
          projectId: string;
          target: string;
          expectedRevision: number;
          planDigest: string;
          targetHashes: string;
          expiresAt: string;
        }>(sql`
          SELECT status, tool, project_id AS projectId, target,
            expected_revision AS expectedRevision, plan_digest AS planDigest,
            target_hashes AS targetHashes, expires_at AS expiresAt
          FROM approval_grant WHERE id = ${grant.grantId}
        `);
        if (!row || row.status !== "issued") {
          throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "approval grant is not issued");
        }
        if (row.expiresAt <= now) {
          transaction.run(sql`
            UPDATE approval_grant SET status = 'expired'
            WHERE id = ${grant.grantId} AND status = 'issued'
          `);
          return { error: new JournalTransactionError(ErrorCode.ApprovalExpired, "approval grant has expired") };
        }
        const binding = grant.binding;
        const bindingMatches = row.tool === binding.tool
          && row.projectId === binding.projectId
          && row.target === binding.target
          && row.expectedRevision === binding.expectedRevision
          && row.planDigest === binding.planDigest
          && row.targetHashes === canonicalizeJson(binding.targetHashes);
        if (!bindingMatches || binding.projectId !== intent.projectId) {
          throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "approval grant binding does not match");
        }
        const latestRevision = transaction.get<{ id: number }>(sql`
          SELECT id FROM revision WHERE project_id = ${intent.projectId} ORDER BY id DESC LIMIT 1
        `)?.id ?? 0;
        if (latestRevision !== binding.expectedRevision) {
          throw new JournalTransactionError(ErrorCode.WriteConflict, "project revision changed after approval");
        }
        const reserved = transaction.get<{ id: string }>(sql`
          UPDATE approval_grant SET status = 'reserved', reserved_at = ${now}
          WHERE id = ${grant.grantId} AND status = 'issued' AND expires_at > ${now}
          RETURNING id
        `);
        if (!reserved) {
          throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "approval grant reserve lost a concurrent transition");
        }
      }

      const single = steps.length === 1 ? steps[0] : null;
      const kind = single?.kind === "entity" ? "entity" : single ? "file" : "composite";
      const previous = single ? preparedSteps[single.ordinal]! : null;
      const journal = transaction.get<{ id: number }>(sql`
        INSERT INTO mutation_journal (
          project_id, kind, path, entity, from_hash, previous_content, previous_object_hash, previous_byte_size,
          staged_tmp_path, staged_target_path, staged_content_hash, to_hash, status, actor,
          grant_id, backup_id, tool_audit_json, created_at, settled_at
        ) VALUES (
          ${intent.projectId}, ${kind}, ${single?.path ?? null}, ${single?.entity ?? null},
          ${single?.fromHash ?? null}, ${previous?.inline ?? null}, ${previous?.objectHash ?? null}, ${previous?.byteSize ?? 0},
          NULL, NULL, NULL, ${single?.toHash ?? null}, 'pending', ${intent.actor},
          ${grant?.grantId ?? null}, NULL, ${auditJson}, ${now}, NULL
        ) RETURNING id
      `);
      if (!journal) throw new Error("composite mutation journal insert returned no id");
      for (const step of steps) {
        const stepPrevious = preparedSteps[step.ordinal]!;
        transaction.run(sql`
          INSERT INTO mutation_step (
            journal_id, ordinal, kind, path, entity, from_hash, to_hash,
            previous_content, previous_object_hash, previous_byte_size, status
          ) VALUES (
            ${journal.id}, ${step.ordinal}, ${step.kind}, ${step.path}, ${step.entity},
            ${step.fromHash}, ${step.toHash}, ${stepPrevious.inline}, ${stepPrevious.objectHash}, ${stepPrevious.byteSize}, 'pending'
          )
        `);
      }
      return journal.id as JournalId;
    });
    if (typeof outcome !== "number") throw outcome.error;
    return outcome;
  }

  /** Persists a verified filesystem capture before the corresponding target can publish. */
  async markStepCaptured(
    id: JournalId,
    ordinal: number,
    rollbackPath: ResolvedPath | null,
    capturedHash: ContentHash | null,
  ): Promise<void> {
    const result = this.database.run(sql`
      UPDATE mutation_step
      SET rollback_path = ${rollbackPath}, captured_hash = ${capturedHash}, capture_state = 'captured'
      WHERE journal_id = ${id} AND ordinal = ${ordinal} AND capture_state = 'pending'
        AND ((previous_content IS NULL AND previous_object_hash IS NULL AND ${capturedHash} IS NULL)
          OR ((previous_content IS NOT NULL OR previous_object_hash IS NOT NULL) AND from_hash IS ${capturedHash}))
        AND EXISTS (
          SELECT 1 FROM mutation_journal
          WHERE mutation_journal.id = mutation_step.journal_id
            AND mutation_journal.status = 'pending'
        )
    `);
    if (result.changes !== 1) {
      throw new JournalTransactionError(
        ErrorCode.WriteConflict,
        "captured mutation step no longer matches its durable intent",
      );
    }
  }

  /** Links a verified backup to a pending journal and enriches its durable audit context atomically. */
  async attachBackup(id: JournalId, backupId: string): Promise<void> {
    this.database.transaction((transaction) => {
      const row = transaction.get<{ projectId: string; auditJson: string | null }>(sql`
        SELECT project_id AS projectId, tool_audit_json AS auditJson
        FROM mutation_journal WHERE id = ${id} AND status = 'pending'
      `);
      if (!row) throw new Error("pending mutation journal was not found");
      const backup = transaction.get<{ projectId: string }>(sql`
        SELECT project_id AS projectId FROM backup_manifest WHERE id = ${backupId}
      `);
      if (!backup || backup.projectId !== row.projectId) {
        throw new Error("backup manifest does not belong to the mutation project");
      }
      let auditJson = row.auditJson;
      if (auditJson !== null) {
        const audit = storedMutationContext(auditJson);
        if (audit.toolAudit) {
          auditJson = serializePendingToolAudit({
            ...audit.toolAudit,
            detail: { ...audit.toolAudit.detail, backupId },
          });
        }
      }
      transaction.run(sql`
        UPDATE mutation_journal SET backup_id = ${backupId}, tool_audit_json = ${auditJson}
        WHERE id = ${id} AND status = 'pending'
      `);
    });
  }

  /** Commits revision history, durable audits, event, backup and grant terminal state in one transaction. */
  async commitComposite(
    id: JournalId,
    result: CompositeResult,
    grant?: Extract<GrantTransition, { kind: "consume" }>,
  ): Promise<WriteEnvelope> {
    return this.settleCompositeCommit(id, result, "pending", "committed", true, grant);
  }

  async commitDerivedComposite(id: JournalId, result: CompositeResult): Promise<WriteEnvelope> {
    if (!isDerivedComposite(result)) {
      throw new JournalTransactionError(
        ErrorCode.AssetNotAllowed,
        "a derived journal commit contains a source or entity target",
      );
    }
    return this.settleCompositeCommit(id, result, "pending", "committed", false);
  }

  /** Accepts a validated orphan state without reviving or consuming its already-invalidated grant. */
  async resolveOrphanedAccept(id: JournalId, result: CompositeResult): Promise<WriteEnvelope> {
    return this.settleCompositeCommit(
      id,
      result,
      "orphaned",
      "recovered",
      !isDerivedComposite(result),
    );
  }

  private async settleCompositeCommit(
    id: JournalId,
    result: CompositeResult,
    sourceStatus: "pending" | "orphaned",
    terminalStatus: "committed" | "recovered",
    advancesSource: boolean,
    grant?: Extract<GrantTransition, { kind: "consume" }>,
  ): Promise<WriteEnvelope> {
    assertOrderedSteps(result.steps);
    const preparedSteps = await Promise.all(result.steps.map((step) => this.preparePrevious(step.previousContent)));
    const now = this.clock.now().toISOString();
    const envelope = this.database.transaction((transaction) => {
      const journal = transaction.get<{
        projectId: string;
        actor: Actor;
        grantId: string | null;
        backupId: string | null;
        auditJson: string | null;
      }>(sql`
        SELECT project_id AS projectId, actor, grant_id AS grantId,
          backup_id AS backupId, tool_audit_json AS auditJson
        FROM mutation_journal WHERE id = ${id} AND status = ${sourceStatus}
      `);
      if (!journal || journal.projectId !== result.projectId
        || (sourceStatus === "pending" && journal.actor !== result.actor)) {
        throw new Error("pending mutation journal does not match composite result");
      }
      if (sourceStatus === "pending" && (grant?.grantId ?? null) !== journal.grantId) {
        throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "terminal grant does not match journal");
      }

      const single = result.steps.length === 1 ? result.steps[0] : null;
      const revisionKind = single?.kind === "entity" ? "entity" : single ? "file" : "composite";
      const revisionHash = single?.toHash ?? compositeManifestHash(result.steps);
      const parent = transaction.get<{ id: number }>(sql`
        SELECT id FROM revision WHERE project_id = ${result.projectId} ORDER BY id DESC LIMIT 1
      `);
      const context = journal.auditJson === null ? { toolAudit: null } : storedMutationContext(journal.auditJson);
      const revisionSummary = context.commandAudit?.action === "derived.write"
        ? canonicalizeJson(context.commandAudit.detail)
        : null;
      const revision = transaction.get<{ id: number }>(sql`
        INSERT INTO revision (
          project_id, kind, path, entity, content_hash, parent_revision, actor, summary, advances_source, created_at
        ) VALUES (
          ${result.projectId}, ${revisionKind}, ${single?.path ?? null}, ${single?.entity ?? null},
          ${revisionHash}, ${parent?.id ?? null}, ${result.actor}, ${revisionSummary}, ${advancesSource ? 1 : 0}, ${now}
        ) RETURNING id
      `);
      if (!revision) throw new Error("composite revision insert returned no id");

      let entityRevision: number | null = null;
      const fileHashes: Record<RelPath, ContentHash> = {};
      for (const step of result.steps) {
        const previous = preparedSteps[step.ordinal]!;
        transaction.run(sql`
          INSERT INTO revision_step (
            revision_id, ordinal, kind, path, entity, from_hash, to_hash,
            previous_content, previous_object_hash, byte_size, backup_id
          ) VALUES (
            ${revision.id}, ${step.ordinal}, ${step.kind}, ${step.path}, ${step.entity},
            ${step.fromHash}, ${step.toHash}, ${previous.inline}, ${previous.objectHash}, ${previous.byteSize}, ${journal.backupId}
          )
        `);
        transaction.run(sql`
          UPDATE mutation_step SET status = 'written'
          WHERE journal_id = ${id} AND ordinal = ${step.ordinal}
        `);
        if (step.kind === "entity") {
          const entity = transaction.get<{ revision: number; backingPath: string }>(sql`
            UPDATE entity_state SET revision = revision + 1, content_hash = ${step.toHash},
              last_actor = ${result.actor}, updated_at = ${now}
            WHERE project_id = ${result.projectId} AND entity = ${step.entity}
            RETURNING revision, backing_path AS backingPath
          `);
          if (!entity) throw new Error("composite entity state was not seeded");
          entityRevision = entity.revision;
          fileHashes[entity.backingPath as RelPath] = step.toHash;
        } else if (step.kind === "write") {
          fileHashes[step.path] = step.toHash;
        }
      }

      if (single) {
        const previous = preparedSteps[single.ordinal]!;
        transaction.run(sql`
          INSERT INTO revision_blob (revision_id, previous_content, previous_object_hash, byte_size)
          VALUES (${revision.id}, ${previous.inline}, ${previous.objectHash}, ${previous.byteSize})
        `);
      }
      if (!advancesSource) {
        const stale = transaction.all<{ revisionId: number; path: string }>(sql`
          SELECT revision_id AS revisionId, path FROM (
            SELECT revision_step.revision_id, revision_step.path,
              ROW_NUMBER() OVER (
                PARTITION BY revision_step.path ORDER BY revision_step.revision_id DESC
              ) AS generation
            FROM revision_step
            INNER JOIN revision ON revision.id = revision_step.revision_id
            WHERE revision.project_id = ${result.projectId}
              AND revision.advances_source = 0
              AND revision_step.path IS NOT NULL
          ) WHERE generation > ${DERIVED_ROLLBACK_GENERATIONS}
        `);
        for (const row of stale) {
          transaction.run(sql`
            UPDATE revision_step
            SET previous_content = NULL, previous_object_hash = NULL, byte_size = 0
            WHERE revision_id = ${row.revisionId} AND path = ${row.path}
          `);
          transaction.run(sql`DELETE FROM revision_blob WHERE revision_id = ${row.revisionId}`);
        }
      }
      if (journal.backupId) {
        const linked = transaction.get<{ id: string }>(sql`
          UPDATE backup_manifest SET revision_id = ${revision.id}
          WHERE id = ${journal.backupId} AND project_id = ${result.projectId} AND revision_id IS NULL
          RETURNING id
        `);
        if (!linked) throw new Error("backup manifest could not be linked to revision");
      }

      const mutationAction = single?.kind === "entity"
        ? "entity.patch"
        : single?.kind === "write"
          ? "file.write"
          : single?.kind === "delete"
            ? "file.delete"
            : "composite.write";
      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${result.projectId}, ${mutationAction}, ${result.actor}, ${revision.id}, NULL, NULL,
          'ok', NULL, NULL, ${now}
        )
      `);
      if (sourceStatus === "pending" && journal.auditJson !== null) {
        const audit = context.toolAudit;
        const command = context.commandAudit;
        transaction.run(sql`
          INSERT INTO audit_entry (
            project_id, action, actor, revision_id, job_id, protocol_version,
            outcome, error_code, detail, created_at
          ) VALUES (
            ${result.projectId}, ${command?.action ?? `tool:${audit?.tool}`}, ${result.actor}, ${revision.id}, NULL,
            ${audit?.protocolVersion ?? null}, 'ok', NULL, ${canonicalizeJson(command
              ? { ...command.detail, ...(result.recovered ? { recovered: true } : {}) }
              : terminalToolAuditDetail(
                  audit,
                  now,
                  revision.id,
                  result.recovered ? { recovered: true } : {},
                ))}, ${audit?.invokedAt ?? now}
          )
        `);
      }
      transaction.run(sql`
        INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES (${result.event.type}, ${result.event.projectId}, ${canonicalizeJson(result.event.payload)}, ${now})
      `);
      if (sourceStatus === "pending" && grant) {
        const consumed = transaction.get<{ id: string }>(sql`
          UPDATE approval_grant SET status = 'consumed', consumed_at = ${now}
          WHERE id = ${grant.grantId} AND status = 'reserved'
          RETURNING id
        `);
        if (!consumed) throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "reserved grant could not be consumed");
      }
      if (sourceStatus === "orphaned") {
        transaction.run(sql`
          INSERT INTO audit_entry (
            project_id, action, actor, revision_id, job_id, protocol_version,
            outcome, error_code, detail, created_at
          ) VALUES (
            ${result.projectId}, 'recovery.accept_current', 'cli-external', ${revision.id}, NULL, NULL,
            'ok', NULL, ${canonicalizeJson({ journalId: id })}, ${now}
          )
        `);
      }
      const settled = transaction.get<{ id: number }>(sql`
        UPDATE mutation_journal SET status = ${terminalStatus}, settled_at = ${now}
        WHERE id = ${id} AND status = ${sourceStatus} RETURNING id
      `);
      if (!settled) throw new Error("composite journal commit lost terminal transition");
      return {
        projectRevision: revision.id,
        entityRevision,
        fileHashes,
        diagnostics: result.diagnostics,
      };
    });
    if (!advancesSource && this.largeContent?.cleanupUnreferenced) {
      await this.largeContent.cleanupUnreferenced(
        await this.listPreviousObjectHashes(),
      ).catch(() => 0);
    }
    return envelope;
  }

  /** Aborts an unchanged mutation, releases its reserved grant and returns cleared audit context for best-effort recording. */
  async abortComposite(
    id: JournalId,
    _reason: ErrorCode,
    grant?: Extract<GrantTransition, { kind: "release" }>,
  ): Promise<PendingMutationContext | null> {
    return this.settleRestoredComposite(id, "aborted", grant);
  }

  /** Marks a verified mixed mutation rolled back, releases its grant and returns its cleared audit context. */
  async rollbackComposite(
    id: JournalId,
    _reason: ErrorCode,
    grant?: Extract<GrantTransition, { kind: "release" }>,
  ): Promise<PendingMutationContext | null> {
    return this.settleRestoredComposite(id, "rolled_back", grant);
  }

  /** Finalizes an explicit, already-verified restore while retaining orphan evidence and grant invalidation. */
  async resolveOrphanedRestore(id: JournalId, actor: "cli-external"): Promise<void> {
    const now = this.clock.now().toISOString();
    this.database.transaction((transaction) => {
      const journal = transaction.get<{ projectId: string }>(sql`
        SELECT project_id AS projectId FROM mutation_journal
        WHERE id = ${id} AND status = 'orphaned'
      `);
      if (!journal) throw new Error("orphaned mutation journal was not found");
      transaction.run(sql`
        UPDATE mutation_step SET status = 'rolled_back' WHERE journal_id = ${id}
      `);
      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${journal.projectId}, 'recovery.restore_previous', ${actor}, NULL, NULL, NULL,
          'ok', NULL, ${canonicalizeJson({ journalId: id })}, ${now}
        )
      `);
      const settled = transaction.get<{ id: number }>(sql`
        UPDATE mutation_journal SET status = 'rolled_back', settled_at = ${now}
        WHERE id = ${id} AND status = 'orphaned' RETURNING id
      `);
      if (!settled) throw new Error("orphan restore terminal transition was lost");
    });
  }

  private settleRestoredComposite(
    id: JournalId,
    status: "aborted" | "rolled_back",
    grant?: Extract<GrantTransition, { kind: "release" }>,
  ): PendingMutationContext | null {
    const now = this.clock.now().toISOString();
    return this.database.transaction((transaction) => {
      const journal = transaction.get<{ grantId: string | null; auditJson: string | null }>(sql`
        SELECT grant_id AS grantId, tool_audit_json AS auditJson
        FROM mutation_journal WHERE id = ${id} AND status = 'pending'
      `);
      if (!journal) return null;
      if ((grant?.grantId ?? null) !== journal.grantId) {
        throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "terminal grant does not match journal");
      }
      if (grant) {
        const released = transaction.get<{ id: string }>(sql`
          UPDATE approval_grant SET status = 'issued', reserved_at = NULL
          WHERE id = ${grant.grantId} AND status = 'reserved'
          RETURNING id
        `);
        if (!released) throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "reserved grant could not be released");
      }
      const settled = transaction.get<{ id: number }>(sql`
        UPDATE mutation_journal SET status = ${status}, settled_at = ${now},
          grant_id = NULL, tool_audit_json = NULL
        WHERE id = ${id} AND status = 'pending' RETURNING id
      `);
      if (!settled) throw new Error("composite journal abort lost terminal transition");
      if (status === "rolled_back") {
        transaction.run(sql`
          UPDATE mutation_step SET status = 'rolled_back' WHERE journal_id = ${id}
        `);
      }
      return storedMutationContext(journal.auditJson);
    });
  }

  /** Marks a mutation orphaned with its durable tool audit and invalidates the exact linked grant atomically. */
  async orphanComposite(
    id: JournalId,
    reason: ErrorCode,
    grant?: Extract<GrantTransition, { kind: "invalidate" }>,
  ): Promise<void> {
    const now = this.clock.now().toISOString();
    this.database.transaction((transaction) => {
      const journal = transaction.get<{
        projectId: string;
        actor: Actor;
        grantId: string | null;
        auditJson: string | null;
      }>(sql`
        SELECT project_id AS projectId, actor, grant_id AS grantId, tool_audit_json AS auditJson
        FROM mutation_journal WHERE id = ${id} AND status = 'pending'
      `);
      if (!journal) return;
      if ((grant?.grantId ?? null) !== journal.grantId) {
        throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "terminal grant does not match journal");
      }
      if (grant) {
        const invalidated = transaction.get<{ id: string }>(sql`
          UPDATE approval_grant SET status = 'invalidated', invalidated_at = ${now},
            invalidated_reason = ${grant.reason}
          WHERE id = ${grant.grantId} AND status = 'reserved'
          RETURNING id
        `);
        if (!invalidated) throw new JournalTransactionError(ErrorCode.ApprovalInvalid, "reserved grant could not be invalidated");
      }
      if (journal.auditJson !== null) {
        const context = storedMutationContext(journal.auditJson);
        const audit = context.toolAudit;
        const command = context.commandAudit;
        const revisionAfter = transaction.get<{ id: number }>(sql`
          SELECT id FROM revision WHERE project_id = ${journal.projectId} ORDER BY id DESC LIMIT 1
        `)?.id ?? 0;
        transaction.run(sql`
          INSERT INTO audit_entry (
            project_id, action, actor, revision_id, job_id, protocol_version,
            outcome, error_code, detail, created_at
          ) VALUES (
            ${journal.projectId}, ${command?.action ?? `tool:${audit?.tool}`}, ${journal.actor}, NULL, NULL,
            ${audit?.protocolVersion ?? null}, 'error', ${reason}, ${canonicalizeJson(command
              ? command.detail
              : terminalToolAuditDetail(audit, now, revisionAfter))}, ${audit?.invokedAt ?? now}
          )
        `);
      }
      const settled = transaction.get<{ id: number }>(sql`
        UPDATE mutation_journal SET status = 'orphaned', settled_at = ${now}
        WHERE id = ${id} AND status = 'pending' RETURNING id
      `);
      if (!settled) throw new Error("composite journal orphan transition was lost");
    });
  }

  /** Reads ordered durable step intents for one journal; an empty array means no rows exist. */
  async readSteps(id: JournalId): Promise<StepIntent[]> {
    const rows = this.database.all<StoredStepRow>(sql`
      SELECT ordinal, kind, path, entity, from_hash AS fromHash, to_hash AS toHash,
        previous_content AS previousContent, previous_object_hash AS previousObjectHash
      FROM mutation_step WHERE journal_id = ${id} ORDER BY ordinal
    `);
    return Promise.all(rows.map(async (row) => storedStepIntent(row, await this.hydratePrevious(row))));
  }

  /** Reads only revision steps durably linked to the exact backup and destructive revision. */
  async readBackupRevisionSteps(backupId: string, revisionId: number): Promise<StepIntent[]> {
    const rows = this.database.all<StoredStepRow>(sql`
      SELECT ordinal, kind, path, entity, from_hash AS fromHash, to_hash AS toHash,
        previous_content AS previousContent, previous_object_hash AS previousObjectHash
      FROM revision_step
      WHERE backup_id = ${backupId} AND revision_id = ${revisionId}
      ORDER BY ordinal
    `);
    return Promise.all(rows.map(async (row) => storedStepIntent(row, await this.hydratePrevious(row))));
  }

  /** Reads one rollback slot without confusing a pruned payload with a previously absent file. */
  async readRevisionRollbackPayload(
    revisionId: number,
    path: RelPath,
  ): Promise<Result<Uint8Array | null, DomainError>> {
    const row = this.database.get<{
      fromHash: string | null;
      previousContent: Uint8Array | null;
      previousObjectHash: string | null;
      generation: number;
    }>(sql`
      WITH ranked AS (
        SELECT revision_step.revision_id AS revisionId,
          revision_step.from_hash AS fromHash,
          revision_step.previous_content AS previousContent,
          revision_step.previous_object_hash AS previousObjectHash,
          ROW_NUMBER() OVER (
            PARTITION BY revision.project_id, revision_step.path
            ORDER BY revision_step.revision_id DESC
          ) AS generation
        FROM revision_step
        INNER JOIN revision ON revision.id = revision_step.revision_id
        WHERE revision.advances_source = 0 AND revision_step.path = ${path}
      )
      SELECT fromHash, previousContent, previousObjectHash, generation
      FROM ranked WHERE revisionId = ${revisionId}
    `);
    if (!row) {
      return err({ code: ErrorCode.NotFound, message: "the derived revision path was not found" });
    }
    if (row.generation > DERIVED_ROLLBACK_GENERATIONS) {
      return err({
        code: ErrorCode.RollbackPayloadPruned,
        message: "the derived rollback payload is outside the retained generation window",
      });
    }
    if (row.fromHash === null) return ok(null);
    if (row.previousContent === null && row.previousObjectHash === null) {
      return err({
        code: ErrorCode.StorageUnavailable,
        message: "the retained rollback payload is missing",
      });
    }
    try {
      return ok(await this.hydrateContent(row.previousContent, row.previousObjectHash));
    } catch {
      return err({
        code: ErrorCode.StorageUnavailable,
        message: "the retained rollback payload could not be read",
      });
    }
  }

  /** Returns the live content-addressed rollback references used by safe startup compaction. */
  async listPreviousObjectHashes(): Promise<Set<string>> {
    const rows = this.database.all<{ hash: string }>(sql`
      SELECT previous_object_hash AS hash FROM mutation_journal
        WHERE previous_object_hash IS NOT NULL AND status IN ('pending', 'orphaned')
      UNION SELECT mutation_step.previous_object_hash AS hash FROM mutation_step
        INNER JOIN mutation_journal ON mutation_journal.id = mutation_step.journal_id
        WHERE mutation_step.previous_object_hash IS NOT NULL
          AND mutation_journal.status IN ('pending', 'orphaned')
      UNION SELECT previous_object_hash AS hash FROM revision_step WHERE previous_object_hash IS NOT NULL
      UNION SELECT previous_object_hash AS hash FROM revision_blob WHERE previous_object_hash IS NOT NULL
      UNION SELECT workspace_operation_step.previous_object_hash AS hash FROM workspace_operation_step
        INNER JOIN workspace_operation ON workspace_operation.id = workspace_operation_step.operation_id
        WHERE workspace_operation_step.previous_object_hash IS NOT NULL
          AND workspace_operation.status IN ('pending', 'orphaned')
    `);
    return new Set(rows.map(({ hash }) => hash));
  }

  /** Reads one unresolved journal with its exact grant, backup, context and ordered steps. */
  async readPendingComposite(id: JournalId): Promise<PendingCompositeMutation | null> {
    const row = this.database.get<{
      projectId: string;
      actor: Actor;
      status: "pending" | "orphaned";
      grantId: string | null;
      backupId: string | null;
      auditJson: string | null;
    }>(sql`
      SELECT project_id AS projectId, actor, status, grant_id AS grantId,
        backup_id AS backupId, tool_audit_json AS auditJson
      FROM mutation_journal WHERE id = ${id} AND status IN ('pending', 'orphaned')
    `);
    if (!row) return null;
    return {
      id,
      projectId: row.projectId as ProjectId,
      actor: row.actor,
      status: row.status,
      steps: await this.readSteps(id),
      context: storedMutationContext(row.auditJson),
      grantId: row.grantId,
      backupId: row.backupId,
    };
  }

  /** Lists unresolved journals scoped to one exact workspace registration root. */
  async listPendingComposites(workspaceRoot: string): Promise<PendingCompositeMutation[]> {
    const ids = this.database.all<{ id: number }>(sql`
      SELECT mutation_journal.id AS id FROM mutation_journal
      INNER JOIN project_registry ON project_registry.id = mutation_journal.project_id
      WHERE mutation_journal.status IN ('pending', 'orphaned')
        AND project_registry.workspace_root = ${workspaceRoot}
      ORDER BY mutation_journal.created_at, mutation_journal.id
    `);
    const pending = await Promise.all(ids.map(({ id }) => this.readPendingComposite(id as JournalId)));
    return pending.filter((row): row is PendingCompositeMutation => row !== null);
  }

  /** Returns whether any pending or terminal journal retains ownership of an invocation's durable audit. */
  async isJournalOwned(invocationId: string): Promise<boolean> {
    return this.database.get<{ owned: number }>(sql`
      SELECT 1 AS owned FROM mutation_journal
      WHERE tool_audit_json IS NOT NULL
        AND json_extract(tool_audit_json, '$.invocationId') = ${invocationId}
      LIMIT 1
    `) !== undefined;
  }

  /** Reads every unresolved journal that currently gates project writes. */
  async readProjectRecoveryStatus(projectId: ProjectId): Promise<ProjectRecoveryStatus> {
    const unresolved = this.database.all<{ journalId: number; status: "pending" | "orphaned" }>(sql`
      SELECT id AS journalId, status FROM mutation_journal
      WHERE project_id = ${projectId} AND status IN ('pending', 'orphaned')
      ORDER BY created_at, id
    `).map((row) => ({ ...row, journalId: row.journalId as JournalId }));
    return {
      writeStatus: unresolved.length === 0 ? "ready" : "recovery_required",
      unresolved,
    };
  }

  /** Rejects writes while any pending or orphaned journal exists for the project. */
  async assertProjectWritable(projectId: ProjectId): Promise<void> {
    const status = await this.readProjectRecoveryStatus(projectId);
    if (status.writeStatus === "recovery_required") {
      throw new JournalTransactionError(ErrorCode.RecoveryRequired, "project has unresolved mutations");
    }
  }

  async begin(intent: MutationIntent): Promise<JournalId> {
    const previous = await this.preparePrevious(intent.previousContent);
    return this.database.transaction((transaction) => {
      const row = transaction.get<{ id: number }>(sql`
        INSERT INTO mutation_journal (
          project_id, kind, path, entity, from_hash, previous_content, previous_object_hash, previous_byte_size,
          staged_tmp_path, staged_target_path, staged_content_hash, to_hash, actor, created_at, settled_at
        ) VALUES (
          ${intent.projectId}, ${intent.kind}, ${intent.path}, ${intent.entity}, ${intent.fromHash},
          ${previous.inline}, ${previous.objectHash}, ${previous.byteSize}, ${intent.stagedAsset?.temporaryPath ?? null},
          ${intent.stagedAsset?.targetPath ?? null}, ${intent.stagedAsset?.contentHash ?? null},
          ${intent.toHash}, ${intent.actor}, ${this.clock.now().toISOString()}, NULL
        ) RETURNING id
      `);
      if (!row) throw new Error("mutation journal insert returned no id");
      transaction.run(sql`
        INSERT INTO mutation_step (
          journal_id, ordinal, kind, path, entity, from_hash, to_hash,
          previous_content, previous_object_hash, previous_byte_size, status
        ) VALUES (
          ${row.id}, 0, ${intent.kind === "entity" ? "entity" : "write"}, ${intent.path}, ${intent.entity},
          ${intent.fromHash}, ${intent.toHash}, ${previous.inline}, ${previous.objectHash}, ${previous.byteSize}, 'pending'
        )
      `);
      return row.id as JournalId;
    });
  }

  async abort(id: JournalId, reason: ErrorCode): Promise<void> {
    const now = this.clock.now().toISOString();
    this.database.transaction((transaction) => {
      const journal = transaction.get<{ projectId: string; actor: Actor }>(sql`
        UPDATE mutation_journal SET status = 'aborted', settled_at = ${now}
        WHERE id = ${id} AND status = 'pending'
        RETURNING project_id AS projectId, actor
      `);
      if (!journal) return;
      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${journal.projectId}, 'mutation.abort', ${journal.actor}, NULL, NULL, NULL,
          'error', ${reason}, NULL, ${now}
        )
      `);
    });
  }

  async listPending(): Promise<PendingMutation[]> {
    const rows = this.database.all<{
      id: number; projectId: string; kind: "file" | "entity"; path: string | null;
      entity: "preview-settings" | null; fromHash: string | null; toHash: string;
      actor: Actor; previousContent: Uint8Array | null; previousObjectHash: string | null; stagedTmpPath: string | null;
      stagedTargetPath: string | null; stagedContentHash: string | null;
    }>(sql`
      SELECT id, project_id AS projectId, kind, path, entity, from_hash AS fromHash,
        to_hash AS toHash, actor, previous_content AS previousContent,
        previous_object_hash AS previousObjectHash,
        staged_tmp_path AS stagedTmpPath, staged_target_path AS stagedTargetPath,
        staged_content_hash AS stagedContentHash
      FROM mutation_journal WHERE status = 'pending' ORDER BY created_at, id
    `);
    return Promise.all(rows.map(async (row) => ({
      id: row.id as JournalId,
      projectId: row.projectId as ProjectId,
      kind: row.kind,
      path: row.path as RelPath | null,
      entity: row.entity,
      fromHash: row.fromHash as ContentHash | null,
      toHash: row.toHash as ContentHash,
      actor: row.actor,
      previousContent: await this.hydrateContent(row.previousContent, row.previousObjectHash),
      stagedAsset: row.stagedTmpPath && row.stagedTargetPath && row.stagedContentHash
        ? {
            temporaryPath: row.stagedTmpPath,
            targetPath: row.stagedTargetPath as RelPath,
            contentHash: row.stagedContentHash as ContentHash,
          }
        : null,
    })));
  }

  async latestRevision(projectId: ProjectId): Promise<number | null> {
    return this.database.get<{ id: number }>(sql`
      SELECT id FROM revision WHERE project_id = ${projectId} ORDER BY id DESC LIMIT 1
    `)?.id ?? null;
  }

  async latestSourceRevision(projectId: ProjectId): Promise<number | null> {
    return this.database.get<{ id: number }>(sql`
      SELECT id FROM revision
      WHERE project_id = ${projectId} AND advances_source = 1
      ORDER BY id DESC LIMIT 1
    `)?.id ?? null;
  }

  async listProjectRevisions(projectId: ProjectId): Promise<ProjectRevisionProjection[]> {
    const rows = this.database.all<{
      revision: number; sourceRevision: number; actor: Actor; createdAt: string;
      path: string | null; summary: string | null; kind: string;
    }>(sql`
      SELECT revision.id AS revision,
        COALESCE((
          SELECT MAX(source.id) FROM revision AS source
          WHERE source.project_id = revision.project_id
            AND source.advances_source = 1 AND source.id <= revision.id
        ), 0) AS sourceRevision,
        revision.actor, revision.created_at AS createdAt, revision.path,
        revision.summary, revision.kind
      FROM revision WHERE revision.project_id = ${projectId}
        AND NOT (
          revision.advances_source = 0
          AND (
            revision.path LIKE '.vidcom/%'
            OR (revision.path IS NULL AND NOT EXISTS (
              SELECT 1 FROM revision_step AS visible_step
              WHERE visible_step.revision_id = revision.id
                AND visible_step.path IS NOT NULL
                AND visible_step.path NOT LIKE '.vidcom/%'
            ))
          )
        )
      ORDER BY revision.id
    `);
    return rows.map((row) => {
      const stepPaths = this.database.all<{ path: string }>(sql`
        SELECT path FROM revision_step
        WHERE revision_id = ${row.revision} AND path IS NOT NULL
        ORDER BY ordinal
      `).map(({ path }) => path as RelPath);
      const paths = stepPaths.length > 0 ? stepPaths : row.path ? [row.path as RelPath] : [];
      return {
        revision: row.revision,
        sourceRevision: row.sourceRevision,
        actor: row.actor,
        createdAt: row.createdAt,
        paths,
        summary: row.summary ?? `${row.kind}:${paths.join(",")}`,
      };
    });
  }

  async readEntityState(projectId: ProjectId, entity: "preview-settings"): Promise<EntityState | null> {
    const row = this.database.get<{ revision: number; contentHash: string; backingPath: string }>(sql`
      SELECT revision, content_hash AS contentHash, backing_path AS backingPath
      FROM entity_state WHERE project_id = ${projectId} AND entity = ${entity}
    `);
    return row ? {
      revision: row.revision,
      contentHash: row.contentHash as ContentHash,
      backingPath: row.backingPath as RelPath,
    } : null;
  }

  async findProjectRegistration(projectId: ProjectId): Promise<ProjectRegistration | null> {
    const row = this.database.get<{
      id: string; workspaceRoot: string; slug: string; firstSeenAt: string; lastSeenAt: string;
    }>(sql`
      SELECT id, workspace_root AS workspaceRoot, slug,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM project_registry WHERE id = ${projectId} AND deleted_at IS NULL
    `);
    return row ? { ...row, id: row.id as ProjectId } : null;
  }

  async findProjectRegistrationAt(workspaceRoot: AbsolutePath, slug: string): Promise<ProjectRegistration | null> {
    const row = this.database.get<{
      id: string; workspaceRoot: string; slug: string; firstSeenAt: string; lastSeenAt: string;
    }>(sql`
      SELECT id, workspace_root AS workspaceRoot, slug,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM project_registry
      WHERE workspace_root = ${workspaceRoot} AND slug = ${slug} AND deleted_at IS NULL
    `);
    return row ? { ...row, id: row.id as ProjectId } : null;
  }

  async registerProject(registration: ProjectRegistration, seed: EntitySeed): Promise<void> {
    this.database.transaction((transaction) => {
      const registered = transaction.run(sql`
        INSERT INTO project_registry (id, workspace_root, slug, first_seen_at, last_seen_at)
        VALUES (${registration.id}, ${registration.workspaceRoot}, ${registration.slug}, ${registration.firstSeenAt}, ${registration.lastSeenAt})
        ON CONFLICT(id) DO UPDATE SET workspace_root = excluded.workspace_root,
          slug = excluded.slug, last_seen_at = excluded.last_seen_at
        WHERE project_registry.deleted_at IS NULL
      `);
      if (registered.changes !== 1) throw new Error("tombstoned project identity cannot be registered again");
      transaction.run(sql`
        INSERT INTO entity_state (
          project_id, entity, revision, content_hash, backing_path, last_actor, updated_at
        ) VALUES (
          ${registration.id}, 'preview-settings', ${seed.revision}, ${seed.contentHash},
          ${seed.backingPath}, ${seed.actor}, ${seed.updatedAt}
        ) ON CONFLICT(project_id, entity) DO NOTHING
      `);
    });
  }

  async beginBootstrap(
    registration: ProjectRegistration,
    seed: EntitySeed,
    intent: MutationIntent,
    duplicateFrom: ProjectId | null,
    toolAudit: PendingToolAudit | null = null,
  ): Promise<JournalId> {
    const previous = await this.preparePrevious(intent.previousContent);
    return this.database.transaction((transaction) => {
      const occupied = transaction.get<{ id: string; workspaceRoot: string; slug: string }>(sql`
        SELECT id, workspace_root AS workspaceRoot, slug
        FROM project_registry
        WHERE deleted_at IS NULL
          AND (id = ${registration.id}
            OR (workspace_root = ${registration.workspaceRoot} AND slug = ${registration.slug}))
        LIMIT 1
      `);
      if (occupied && (occupied.id !== registration.id
        || occupied.workspaceRoot !== registration.workspaceRoot
        || occupied.slug !== registration.slug)) {
        throw new Error("project bootstrap registration conflicts with an active identity");
      }
      transaction.run(sql`
        INSERT INTO project_registry (id, workspace_root, slug, first_seen_at, last_seen_at)
        VALUES (${registration.id}, ${registration.workspaceRoot}, ${registration.slug}, ${registration.firstSeenAt}, ${registration.lastSeenAt})
        ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        WHERE project_registry.workspace_root = excluded.workspace_root
          AND project_registry.slug = excluded.slug
          AND project_registry.deleted_at IS NULL
      `);
      transaction.run(sql`
        INSERT INTO entity_state (
          project_id, entity, revision, content_hash, backing_path, last_actor, updated_at
        ) VALUES (
          ${registration.id}, 'preview-settings', ${seed.revision}, ${seed.contentHash},
          ${seed.backingPath}, ${seed.actor}, ${seed.updatedAt}
        ) ON CONFLICT(project_id, entity) DO NOTHING
      `);
      if (duplicateFrom) transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${registration.id}, 'project.id.reassigned', 'system', NULL, NULL, NULL,
          'ok', NULL, ${JSON.stringify({ duplicateFrom })}, ${registration.lastSeenAt}
        )
      `);
      const row = transaction.get<{ id: number }>(sql`
        INSERT INTO mutation_journal (
          project_id, kind, path, entity, from_hash, previous_content, previous_object_hash, previous_byte_size,
          staged_tmp_path, staged_target_path, staged_content_hash, to_hash, actor, tool_audit_json,
          created_at, settled_at
        ) VALUES (
          ${intent.projectId}, ${intent.kind}, ${intent.path}, ${intent.entity}, ${intent.fromHash},
          ${previous.inline}, ${previous.objectHash}, ${previous.byteSize}, ${intent.stagedAsset?.temporaryPath ?? null},
          ${intent.stagedAsset?.targetPath ?? null}, ${intent.stagedAsset?.contentHash ?? null},
          ${intent.toHash}, ${intent.actor}, ${toolAudit === null ? null : serializePendingToolAudit(toolAudit)},
          ${registration.lastSeenAt}, NULL
        ) RETURNING id
      `);
      if (!row) throw new Error("bootstrap journal insert returned no id");
      transaction.run(sql`
        INSERT INTO mutation_step (
          journal_id, ordinal, kind, path, entity, from_hash, to_hash,
          previous_content, previous_object_hash, previous_byte_size, status
        ) VALUES (
          ${row.id}, 0, ${intent.kind === "entity" ? "entity" : "write"}, ${intent.path}, ${intent.entity},
          ${intent.fromHash}, ${intent.toHash}, ${previous.inline}, ${previous.objectHash}, ${previous.byteSize}, 'pending'
        )
      `);
      return row.id as JournalId;
    });
  }

  async commit(id: JournalId, result: MutationResult): Promise<number> {
    return this.settle(id, result, "committed");
  }

  async recover(id: JournalId, result: MutationResult): Promise<number> {
    return this.settle(id, result, "recovered");
  }

  private async settle(
    id: JournalId,
    result: MutationResult,
    status: "committed" | "recovered",
  ): Promise<number> {
    const previous = await this.preparePrevious(result.previousContent);
    const now = this.clock.now().toISOString();
    return this.database.transaction((transaction) => {
      const pending = transaction.get<{ status: string; auditJson: string | null }>(sql`
        SELECT status, tool_audit_json AS auditJson FROM mutation_journal WHERE id = ${id}
      `);
      if (pending?.status !== "pending") throw new Error("mutation journal is not pending");
      const toolAudit = storedMutationContext(pending.auditJson).toolAudit;
      const parent = transaction.get<{ id: number }>(sql`
        SELECT id FROM revision WHERE project_id = ${result.projectId} ORDER BY id DESC LIMIT 1
      `);
      const revision = transaction.get<{ id: number }>(sql`
        INSERT INTO revision (
          project_id, kind, path, entity, content_hash, parent_revision, actor, summary, created_at
        ) VALUES (
          ${result.projectId}, ${result.kind}, ${result.path}, ${result.entity}, ${result.toHash},
          ${parent?.id ?? null}, ${result.actor}, NULL, ${now}
        ) RETURNING id
      `);
      if (!revision) throw new Error("revision insert returned no id");
      transaction.run(sql`
        INSERT INTO revision_blob (revision_id, previous_content, previous_object_hash, byte_size)
        VALUES (${revision.id}, ${previous.inline}, ${previous.objectHash}, ${previous.byteSize})
      `);
      transaction.run(sql`
        INSERT INTO revision_step (
          revision_id, ordinal, kind, path, entity, from_hash, to_hash,
          previous_content, previous_object_hash, byte_size, backup_id
        ) VALUES (
          ${revision.id}, 0, ${result.kind === "entity" ? "entity" : "write"}, ${result.path}, ${result.entity},
          ${result.fromHash}, ${result.toHash}, ${previous.inline}, ${previous.objectHash}, ${previous.byteSize}, NULL
        )
      `);
      transaction.run(sql`
        UPDATE mutation_step SET status = 'written'
        WHERE journal_id = ${id} AND ordinal = 0
      `);
      let returnedRevision = revision.id;
      if (result.kind === "entity") {
        const entity = transaction.get<{ revision: number }>(sql`
          INSERT INTO entity_state (
            project_id, entity, revision, content_hash, backing_path, last_actor, updated_at
          ) VALUES (
            ${result.projectId}, ${result.entity}, 1, ${result.toHash}, 'preview-settings.json', ${result.actor}, ${now}
          ) ON CONFLICT(project_id, entity) DO UPDATE SET
            revision = entity_state.revision + 1,
            content_hash = excluded.content_hash,
            last_actor = excluded.last_actor,
            updated_at = excluded.updated_at
          RETURNING revision
        `);
        returnedRevision = entity?.revision ?? revision.id;
      }
      transaction.run(sql`
        UPDATE mutation_journal SET status = ${status}, settled_at = ${now}
        WHERE id = ${id} AND status = 'pending'
      `);
      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${result.projectId}, ${result.kind === "file" ? "file.write" : "entity.patch"},
          ${result.actor}, ${revision.id}, NULL, NULL, 'ok', NULL, NULL, ${now}
        )
      `);
      // An MCP-owned bootstrap also records its invocation, the way a composite
      // mutation does: without it the tool, era and invocation id the registry
      // promised were durable would exist only in the journal row it clears.
      if (toolAudit) transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${result.projectId}, ${`tool:${toolAudit.tool}`}, ${result.actor}, ${revision.id}, NULL,
          ${toolAudit.protocolVersion}, 'ok', NULL,
          ${canonicalizeJson(terminalToolAuditDetail(toolAudit, now, returnedRevision))}, ${now}
        )
      `);
      transaction.run(sql`
        INSERT INTO event_outbox (type, project_id, payload, created_at)
        VALUES (${result.event.type}, ${result.event.projectId}, ${JSON.stringify(result.event.payload)}, ${now})
      `);
      return returnedRevision;
    });
  }

  async orphan(id: JournalId, actualHash: ContentHash | null): Promise<void> {
    const now = this.clock.now().toISOString();
    this.database.transaction((transaction) => {
      const journal = transaction.get<{
        projectId: string; actor: Actor; fromHash: string | null; toHash: string;
      }>(sql`
        UPDATE mutation_journal SET status = 'orphaned', settled_at = ${now}
        WHERE id = ${id} AND status = 'pending'
        RETURNING project_id AS projectId, actor, from_hash AS fromHash, to_hash AS toHash
      `);
      if (!journal) return;
      transaction.run(sql`
        INSERT INTO audit_entry (
          project_id, action, actor, revision_id, job_id, protocol_version,
          outcome, error_code, detail, created_at
        ) VALUES (
          ${journal.projectId}, 'mutation.orphaned', ${journal.actor}, NULL, NULL, NULL,
          'error', 'write_conflict', ${JSON.stringify({
            fromHash: journal.fromHash,
            toHash: journal.toHash,
            actualHash,
          })}, ${now}
        )
      `);
    });
  }
}
