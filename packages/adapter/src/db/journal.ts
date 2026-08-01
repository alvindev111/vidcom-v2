import { sql } from "drizzle-orm";

import type { Actor, ContentHash, ErrorCode, ProjectId, RelPath } from "@vidcom/contracts";
import type {
  ClockPort,
  EntitySeed,
  EntityState,
  JournalId,
  MutationIntent,
  MutationJournalPort,
  MutationResult,
  PendingMutation,
  ProjectRegistration,
} from "@vidcom/core";

import type { VidcomDatabase } from "./client";

function contentBytes(content: string | Uint8Array | null): Uint8Array | null {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** Drizzle-backed mutation unit-of-work spanning journal, revision, audit and event rows. */
export class MutationJournal implements MutationJournalPort {
  constructor(private readonly database: VidcomDatabase, private readonly clock: ClockPort) {}

  async begin(intent: MutationIntent): Promise<JournalId> {
    const previous = contentBytes(intent.previousContent);
    const row = this.database.get<{ id: number }>(sql`
      INSERT INTO mutation_journal (
        project_id, kind, path, entity, from_hash, previous_content, previous_byte_size,
        staged_tmp_path, staged_target_path, staged_content_hash, to_hash, actor, created_at, settled_at
      ) VALUES (
        ${intent.projectId}, ${intent.kind}, ${intent.path}, ${intent.entity}, ${intent.fromHash},
        ${previous}, ${previous?.byteLength ?? 0}, ${intent.stagedAsset?.temporaryPath ?? null},
        ${intent.stagedAsset?.targetPath ?? null}, ${intent.stagedAsset?.contentHash ?? null},
        ${intent.toHash}, ${intent.actor}, ${this.clock.now().toISOString()}, NULL
      ) RETURNING id
    `);
    if (!row) throw new Error("mutation journal insert returned no id");
    return row.id as JournalId;
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
      actor: Actor; previousContent: Uint8Array | null; stagedTmpPath: string | null;
      stagedTargetPath: string | null; stagedContentHash: string | null;
    }>(sql`
      SELECT id, project_id AS projectId, kind, path, entity, from_hash AS fromHash,
        to_hash AS toHash, actor, previous_content AS previousContent,
        staged_tmp_path AS stagedTmpPath, staged_target_path AS stagedTargetPath,
        staged_content_hash AS stagedContentHash
      FROM mutation_journal WHERE status = 'pending' ORDER BY created_at, id
    `);
    return rows.map((row) => ({
      id: row.id as JournalId,
      projectId: row.projectId as ProjectId,
      kind: row.kind,
      path: row.path as RelPath | null,
      entity: row.entity,
      fromHash: row.fromHash as ContentHash | null,
      toHash: row.toHash as ContentHash,
      actor: row.actor,
      previousContent: row.previousContent,
      stagedAsset: row.stagedTmpPath && row.stagedTargetPath && row.stagedContentHash
        ? {
            temporaryPath: row.stagedTmpPath,
            targetPath: row.stagedTargetPath as RelPath,
            contentHash: row.stagedContentHash as ContentHash,
          }
        : null,
    }));
  }

  async latestRevision(projectId: ProjectId): Promise<number | null> {
    return this.database.get<{ id: number }>(sql`
      SELECT id FROM revision WHERE project_id = ${projectId} ORDER BY id DESC LIMIT 1
    `)?.id ?? null;
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
      FROM project_registry WHERE id = ${projectId}
    `);
    return row ? { ...row, id: row.id as ProjectId } : null;
  }

  async registerProject(registration: ProjectRegistration, seed: EntitySeed): Promise<void> {
    this.database.transaction((transaction) => {
      transaction.run(sql`
        INSERT INTO project_registry (id, workspace_root, slug, first_seen_at, last_seen_at)
        VALUES (${registration.id}, ${registration.workspaceRoot}, ${registration.slug}, ${registration.firstSeenAt}, ${registration.lastSeenAt})
        ON CONFLICT(id) DO UPDATE SET workspace_root = excluded.workspace_root,
          slug = excluded.slug, last_seen_at = excluded.last_seen_at
      `);
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
  ): Promise<JournalId> {
    return this.database.transaction((transaction) => {
      transaction.run(sql`
        INSERT INTO project_registry (id, workspace_root, slug, first_seen_at, last_seen_at)
        VALUES (${registration.id}, ${registration.workspaceRoot}, ${registration.slug}, ${registration.firstSeenAt}, ${registration.lastSeenAt})
      `);
      transaction.run(sql`
        INSERT INTO entity_state (
          project_id, entity, revision, content_hash, backing_path, last_actor, updated_at
        ) VALUES (
          ${registration.id}, 'preview-settings', ${seed.revision}, ${seed.contentHash},
          ${seed.backingPath}, ${seed.actor}, ${seed.updatedAt}
        )
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
      const previous = contentBytes(intent.previousContent);
      const row = transaction.get<{ id: number }>(sql`
        INSERT INTO mutation_journal (
          project_id, kind, path, entity, from_hash, previous_content, previous_byte_size,
          staged_tmp_path, staged_target_path, staged_content_hash, to_hash, actor, created_at, settled_at
        ) VALUES (
          ${intent.projectId}, ${intent.kind}, ${intent.path}, ${intent.entity}, ${intent.fromHash},
          ${previous}, ${previous?.byteLength ?? 0}, ${intent.stagedAsset?.temporaryPath ?? null},
          ${intent.stagedAsset?.targetPath ?? null}, ${intent.stagedAsset?.contentHash ?? null},
          ${intent.toHash}, ${intent.actor}, ${registration.lastSeenAt}, NULL
        ) RETURNING id
      `);
      if (!row) throw new Error("bootstrap journal insert returned no id");
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
    const now = this.clock.now().toISOString();
    return this.database.transaction((transaction) => {
      const pending = transaction.get<{ status: string }>(sql`
        SELECT status FROM mutation_journal WHERE id = ${id}
      `);
      if (pending?.status !== "pending") throw new Error("mutation journal is not pending");
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
      const previous = contentBytes(result.previousContent);
      transaction.run(sql`
        INSERT INTO revision_blob (revision_id, previous_content, byte_size)
        VALUES (${revision.id}, ${previous}, ${previous?.byteLength ?? 0})
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
