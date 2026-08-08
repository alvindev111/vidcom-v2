import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { HOST_DOMAIN_EVENT_TYPES, PROJECT_DOMAIN_EVENT_TYPES } from "@vidcom/contracts";

const actors = ["user", "agent", "cli-external", "system"] as const;
const eventTypes = [...PROJECT_DOMAIN_EVENT_TYPES, ...HOST_DOMAIN_EVENT_TYPES] as const;
const actorCheck = (column: { getSQL(): unknown }) =>
  sql`${column} IN ('user', 'agent', 'cli-external', 'system')`;

export const projectRegistry = sqliteTable("project_registry", {
  id: text().primaryKey(),
  workspaceRoot: text("workspace_root").notNull(),
  slug: text().notNull(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  deletedAt: text("deleted_at"),
}, (table) => [
  uniqueIndex("uq_project_location").on(table.workspaceRoot, table.slug)
    .where(sql`${table.deletedAt} IS NULL`),
  index("idx_project_last_seen").on(table.lastSeenAt),
  index("idx_project_deleted").on(table.deletedAt),
]);

export const workspaceLease = sqliteTable("workspace_lease", {
  workspaceRoot: text("workspace_root").primaryKey(),
  leaseId: text("lease_id").notNull(),
  holderId: text("holder_id").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [index("idx_workspace_lease_expires").on(table.expiresAt)]);

export const mutationJournal = sqliteTable("mutation_journal", {
  id: integer().primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projectRegistry.id),
  kind: text({ enum: ["file", "entity", "composite"] }).notNull(),
  path: text(),
  entity: text(),
  fromHash: text("from_hash"),
  previousContent: blob("previous_content", { mode: "buffer" }),
  previousObjectHash: text("previous_object_hash"),
  previousByteSize: integer("previous_byte_size").notNull().default(0),
  stagedTmpPath: text("staged_tmp_path"),
  stagedTargetPath: text("staged_target_path"),
  stagedContentHash: text("staged_content_hash"),
  toHash: text("to_hash"),
  status: text({ enum: ["pending", "committed", "aborted", "recovered", "orphaned", "rolled_back"] }).notNull().default("pending"),
  actor: text({ enum: actors }).notNull(),
  grantId: text("grant_id").references((): AnySQLiteColumn => approvalGrant.id, { onDelete: "set null" }),
  backupId: text("backup_id").references((): AnySQLiteColumn => backupManifest.id),
  toolAuditJson: text("tool_audit_json"),
  createdAt: text("created_at").notNull(),
  settledAt: text("settled_at"),
}, (table) => [
  index("idx_journal_project").on(table.projectId),
  index("idx_journal_pending").on(table.status, table.createdAt),
  uniqueIndex("uq_journal_grant_id").on(table.grantId).where(sql`${table.grantId} IS NOT NULL`),
  index("idx_journal_project_unresolved").on(table.projectId, table.status),
  check("ck_journal_kind", sql`${table.kind} IN ('file', 'entity', 'composite')`),
  check("ck_journal_status", sql`${table.status} IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned', 'rolled_back')`),
  check("ck_journal_tool_audit_json", sql`${table.toolAuditJson} IS NULL OR json_valid(${table.toolAuditJson})`),
  check("ck_journal_actor", actorCheck(table.actor)),
  check("ck_journal_previous_size", sql`${table.previousByteSize} >= 0`),
]);

export const entityState = sqliteTable("entity_state", {
  projectId: text("project_id").notNull().references(() => projectRegistry.id),
  entity: text().notNull(),
  revision: integer().notNull(),
  contentHash: text("content_hash").notNull(),
  backingPath: text("backing_path").notNull(),
  lastActor: text("last_actor", { enum: actors }).notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.entity] }),
  index("idx_entity_backing").on(table.projectId, table.backingPath),
  check("ck_entity_actor", actorCheck(table.lastActor)),
]);

export const eventOutbox = sqliteTable("event_outbox", {
  seq: integer().primaryKey({ autoIncrement: true }),
  type: text({ enum: eventTypes }).notNull(),
  projectId: text("project_id").references(() => projectRegistry.id),
  payload: text().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_event_type").on(table.type),
  index("idx_event_project").on(table.projectId),
  index("idx_event_created").on(table.createdAt),
  check("ck_event_type", sql`${table.type} IN ('file.changed', 'project.changed', 'job.progress', 'job.done', 'workspace.changed', 'workspace.lease_lost', 'workspace.reattached', 'runtime.preparing', 'runtime.ready')`),
  check("ck_event_project_shape", sql`(${table.type} IN ('workspace.changed', 'workspace.lease_lost', 'workspace.reattached', 'runtime.preparing', 'runtime.ready') AND ${table.projectId} IS NULL) OR (${table.type} IN ('file.changed', 'project.changed', 'job.progress', 'job.done') AND ${table.projectId} IS NOT NULL)`),
]);

export const revision = sqliteTable("revision", {
  id: integer().primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projectRegistry.id),
  kind: text({ enum: ["file", "entity", "composite"] }).notNull(),
  path: text(),
  entity: text(),
  contentHash: text("content_hash").notNull(),
  parentRevision: integer("parent_revision"),
  actor: text({ enum: actors }).notNull(),
  summary: text(),
  advancesSource: integer("advances_source").notNull().default(1),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_revision_project_created").on(table.projectId, table.createdAt),
  index("idx_revision_source").on(table.projectId, table.advancesSource, sql`${table.id} DESC`),
  index("idx_revision_derived_path").on(table.projectId, table.path, sql`${table.id} DESC`)
    .where(sql`${table.advancesSource} = 0`),
  foreignKey({ columns: [table.parentRevision], foreignColumns: [table.id] }),
  check("ck_revision_kind", sql`${table.kind} IN ('file', 'entity', 'composite')`),
  check("ck_revision_actor", actorCheck(table.actor)),
  check("ck_revision_advances_source", sql`${table.advancesSource} IN (0, 1)`),
]);

export const approvalGrant = sqliteTable("approval_grant", {
  id: text().primaryKey(),
  projectId: text("project_id").references(() => projectRegistry.id),
  tool: text().notNull(),
  target: text().notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  planDigest: text("plan_digest").notNull(),
  targetHashes: text("target_hashes").notNull(),
  summary: text().notNull(),
  status: text({
    enum: ["requested", "issued", "reserved", "consumed", "expired", "revoked", "invalidated"],
  }).notNull(),
  approver: text({ enum: ["ui", "cli"] }),
  createdAt: text("created_at").notNull(),
  issuedAt: text("issued_at"),
  reservedAt: text("reserved_at"),
  consumedAt: text("consumed_at"),
  invalidatedAt: text("invalidated_at"),
  invalidatedReason: text("invalidated_reason", { enum: ["orphaned", "rollback_failed"] }),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  index("idx_grant_project").on(table.projectId),
  index("idx_grant_status").on(table.status),
  index("idx_grant_expires").on(table.expiresAt),
  check("ck_grant_expected_revision", sql`${table.expectedRevision} >= 0`),
  check("ck_grant_target_hashes_json", sql`json_valid(${table.targetHashes})`),
  check("ck_grant_owner", sql`(${table.projectId} IS NULL AND ${table.target} LIKE 'location:%') OR (${table.projectId} IS NOT NULL AND ${table.target} NOT LIKE 'location:%')`),
  check("ck_grant_status", sql`${table.status} IN ('requested', 'issued', 'reserved', 'consumed', 'expired', 'revoked', 'invalidated')`),
  check("ck_grant_approver", sql`${table.approver} IS NULL OR ${table.approver} IN ('ui', 'cli')`),
  check("ck_grant_invalidated_reason", sql`${table.invalidatedReason} IS NULL OR ${table.invalidatedReason} IN ('orphaned', 'rollback_failed')`),
]);

export const mcpCredential = sqliteTable("mcp_credential", {
  id: text().primaryKey(),
  label: text().notNull(),
  secretHash: text("secret_hash").notNull(),
  status: text({ enum: ["active", "rotating", "revoked"] }).notNull(),
  createdAt: text("created_at").notNull(),
  rotatedFrom: text("rotated_from").references((): AnySQLiteColumn => mcpCredential.id),
  expiresAt: text("expires_at"),
}, (table) => [
  uniqueIndex("uq_credential_secret_hash").on(table.secretHash),
  index("idx_credential_status").on(table.status),
  check("ck_credential_secret_hash", sql`substr(${table.secretHash}, 1, 7) = 'sha256:' AND length(${table.secretHash}) = 71 AND substr(${table.secretHash}, 8) NOT GLOB '*[^0-9a-f]*'`),
  check("ck_credential_status", sql`${table.status} IN ('active', 'rotating', 'revoked')`),
]);

export const backupManifest = sqliteTable("backup_manifest", {
  id: text().primaryKey(),
  projectId: text("project_id").references(() => projectRegistry.id),
  workspaceRoot: text("workspace_root"),
  slug: text(),
  revisionId: integer("revision_id").unique().references(() => revision.id),
  reason: text().notNull(),
  entries: text().notNull(),
  manifestHash: text("manifest_hash").notNull(),
  createdAt: text("created_at").notNull(),
  payloadPrunedAt: text("payload_pruned_at"),
}, (table) => [
  index("idx_backup_project").on(table.projectId),
  index("idx_backup_location").on(table.workspaceRoot, table.slug),
  index("idx_backup_created").on(table.createdAt),
  check("ck_backup_entries_json", sql`json_valid(${table.entries})`),
  check("ck_backup_owner", sql`(${table.projectId} IS NOT NULL AND ${table.workspaceRoot} IS NULL AND ${table.slug} IS NULL) OR (${table.projectId} IS NULL AND ${table.workspaceRoot} IS NOT NULL AND ${table.slug} IS NOT NULL)`),
]);

export const mutationStep = sqliteTable("mutation_step", {
  id: integer().primaryKey({ autoIncrement: true }),
  journalId: integer("journal_id").notNull().references(() => mutationJournal.id),
  ordinal: integer().notNull(),
  kind: text({ enum: ["write", "delete", "entity"] }).notNull(),
  path: text(),
  entity: text(),
  fromHash: text("from_hash"),
  toHash: text("to_hash"),
  previousContent: blob("previous_content", { mode: "buffer" }),
  previousObjectHash: text("previous_object_hash"),
  previousByteSize: integer("previous_byte_size").notNull().default(0),
  rollbackPath: text("rollback_path"),
  capturedHash: text("captured_hash"),
  captureState: text("capture_state", { enum: ["pending", "captured"] }).notNull().default("pending"),
  status: text({ enum: ["pending", "written", "rolled_back"] }).notNull().default("pending"),
}, (table) => [
  uniqueIndex("uq_step_journal_ordinal").on(table.journalId, table.ordinal),
  index("idx_step_journal").on(table.journalId, table.ordinal),
  check("ck_step_kind", sql`${table.kind} IN ('write', 'delete', 'entity')`),
  check("ck_step_status", sql`${table.status} IN ('pending', 'written', 'rolled_back')`),
  check("ck_step_previous_size", sql`${table.previousByteSize} >= 0`),
  check("ck_step_capture_state", sql`${table.captureState} IN ('pending', 'captured')`),
  check("ck_step_capture_shape", sql`(${table.captureState} = 'pending' OR ((${table.previousContent} IS NULL AND ${table.previousObjectHash} IS NULL AND ${table.capturedHash} IS NULL) OR ((${table.previousContent} IS NOT NULL OR ${table.previousObjectHash} IS NOT NULL) AND ${table.capturedHash} IS ${table.fromHash})))`),
  check("ck_step_shape", sql`((${table.kind} = 'entity' AND ${table.path} IS NULL AND ${table.entity} IS NOT NULL) OR (${table.kind} IN ('write', 'delete') AND ${table.path} IS NOT NULL AND ${table.entity} IS NULL))`),
]);

export const revisionStep = sqliteTable("revision_step", {
  id: integer().primaryKey({ autoIncrement: true }),
  revisionId: integer("revision_id").notNull().references(() => revision.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  kind: text({ enum: ["write", "delete", "entity"] }).notNull(),
  path: text(),
  entity: text(),
  fromHash: text("from_hash"),
  toHash: text("to_hash"),
  previousContent: blob("previous_content", { mode: "buffer" }),
  previousObjectHash: text("previous_object_hash"),
  byteSize: integer("byte_size").notNull().default(0),
  backupId: text("backup_id").references(() => backupManifest.id),
}, (table) => [
  uniqueIndex("uq_revision_step_ordinal").on(table.revisionId, table.ordinal),
  index("idx_revision_step").on(table.revisionId, table.ordinal),
  check("ck_revision_step_kind", sql`${table.kind} IN ('write', 'delete', 'entity')`),
  check("ck_revision_step_size", sql`${table.byteSize} >= 0`),
  check("ck_revision_step_shape", sql`((${table.kind} = 'entity' AND ${table.path} IS NULL AND ${table.entity} IS NOT NULL) OR (${table.kind} IN ('write', 'delete') AND ${table.path} IS NOT NULL AND ${table.entity} IS NULL))`),
]);

export const revisionBlob = sqliteTable("revision_blob", {
  revisionId: integer("revision_id").primaryKey().references(() => revision.id, { onDelete: "cascade" }),
  previousContent: blob("previous_content", { mode: "buffer" }),
  previousObjectHash: text("previous_object_hash"),
  byteSize: integer("byte_size").notNull(),
}, (table) => [check("ck_revision_blob_size", sql`${table.byteSize} >= 0`)]);

export const job = sqliteTable("job", {
  id: text().primaryKey(),
  projectId: text("project_id").references(() => projectRegistry.id),
  type: text().notNull(),
  status: text({ enum: ["queued", "running", "succeeded", "partial", "failed", "cancelled"] }).notNull().default("queued"),
  input: text().notNull(),
  progress: real().notNull().default(0),
  stage: text(),
  result: text(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  warningsJson: text("warnings_json"),
  cleanupPending: integer("cleanup_pending", { mode: "boolean" }).notNull().default(false),
  terminationProofJson: text("termination_proof_json"),
  attempt: integer().notNull().default(0),
  idempotencyKey: text("idempotency_key"),
  inputHash: text("input_hash").notNull(),
  cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
  workerId: text("worker_id"),
  heartbeatAt: text("heartbeat_at"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
}, (table) => [
  index("idx_job_type").on(table.type),
  index("idx_job_claim").on(table.status, table.type, table.createdAt),
  index("idx_job_recovery").on(table.status, table.heartbeatAt),
  index("idx_job_cleanup").on(table.cleanupPending).where(sql`${table.cleanupPending} = 1`),
  uniqueIndex("uq_job_idempotency").on(table.projectId, table.type, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
  check("ck_job_progress", sql`${table.progress} BETWEEN 0 AND 1`),
  check("ck_job_attempt", sql`${table.attempt} >= 0`),
  check("ck_job_status", sql`${table.status} IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')`),
  check("ck_job_cancel", sql`${table.cancelRequested} IN (0, 1)`),
  check("ck_job_cleanup_pending", sql`${table.cleanupPending} IN (0, 1)`),
  check("ck_job_warnings_json", sql`${table.warningsJson} IS NULL OR json_valid(${table.warningsJson})`),
  check("ck_job_termination_proof_json", sql`${table.terminationProofJson} IS NULL OR json_valid(${table.terminationProofJson})`),
]);

export const workspaceOperation = sqliteTable("workspace_operation", {
  id: integer().primaryKey({ autoIncrement: true }),
  workspaceRoot: text("workspace_root").notNull(),
  kind: text({ enum: ["agent_kit_files", "project_create", "project_rename", "project_delete", "project_import"] }).notNull(),
  projectId: text("project_id"),
  fromPath: text("from_path"),
  toPath: text("to_path"),
  stagingPath: text("staging_path"),
  backupId: text("backup_id"),
  grantId: text("grant_id").references(() => approvalGrant.id),
  status: text({ enum: ["pending", "committed", "aborted", "recovered", "orphaned"] }).notNull().default("pending"),
  actor: text({ enum: actors }).notNull(),
  action: text().notNull(),
  toolAuditJson: text("tool_audit_json"),
  createdAt: text("created_at").notNull(),
  settledAt: text("settled_at"),
}, (table) => [
  index("idx_workspace_operation_pending").on(table.status, table.createdAt),
  index("idx_workspace_operation_project").on(table.projectId, table.status),
  uniqueIndex("uq_workspace_operation_grant").on(table.grantId).where(sql`${table.grantId} IS NOT NULL`),
  check("ck_workspace_operation_kind", sql`${table.kind} IN ('agent_kit_files', 'project_create', 'project_rename', 'project_delete', 'project_import')`),
  check("ck_workspace_operation_status", sql`${table.status} IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned')`),
  check("ck_workspace_operation_actor", actorCheck(table.actor)),
  check("ck_workspace_operation_tool_audit_json", sql`${table.toolAuditJson} IS NULL OR json_valid(${table.toolAuditJson})`),
]);

export const workspaceOperationStep = sqliteTable("workspace_operation_step", {
  operationId: integer("operation_id").notNull().references(() => workspaceOperation.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  path: text().notNull(),
  fromHash: text("from_hash"),
  toHash: text("to_hash"),
  previousContent: blob("previous_content", { mode: "buffer" }),
  previousObjectHash: text("previous_object_hash"),
  previousByteSize: integer("previous_byte_size").notNull().default(0),
  rollbackPath: text("rollback_path"),
  capturedHash: text("captured_hash"),
  captureState: text("capture_state", { enum: ["pending", "captured"] }).notNull().default("pending"),
  status: text({ enum: ["pending", "written", "rolled_back"] }).notNull().default("pending"),
}, (table) => [
  primaryKey({ columns: [table.operationId, table.ordinal] }),
  uniqueIndex("uq_workspace_operation_step_path").on(table.operationId, table.path),
  index("idx_workspace_operation_step_path").on(table.path, table.operationId),
  check("ck_workspace_operation_step_previous_size", sql`${table.previousByteSize} >= 0`),
  check("ck_workspace_operation_step_capture_state", sql`${table.captureState} IN ('pending', 'captured')`),
  check("ck_workspace_operation_step_status", sql`${table.status} IN ('pending', 'written', 'rolled_back')`),
]);

export const auditEntry = sqliteTable("audit_entry", {
  id: integer().primaryKey({ autoIncrement: true }),
  projectId: text("project_id").references(() => projectRegistry.id),
  action: text().notNull(),
  actor: text({ enum: actors }).notNull(),
  revisionId: integer("revision_id").references(() => revision.id),
  jobId: text("job_id").references(() => job.id),
  protocolVersion: text("protocol_version"),
  outcome: text({ enum: ["ok", "error"] }).notNull(),
  errorCode: text("error_code"),
  detail: text(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_audit_project").on(table.projectId),
  index("idx_audit_action").on(table.action),
  index("idx_audit_created").on(table.createdAt),
  check("ck_audit_actor", actorCheck(table.actor)),
  check("ck_audit_outcome", sql`${table.outcome} IN ('ok', 'error')`),
]);

export const appSettings = sqliteTable("app_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const registryCache = sqliteTable("registry_cache", {
  key: text().primaryKey(),
  payload: text(),
  fetchedAt: text("fetched_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [index("idx_registry_cache_expires").on(table.expiresAt)]);

export const schema = {
  projectRegistry,
  workspaceLease,
  mutationJournal,
  entityState,
  eventOutbox,
  revision,
  approvalGrant,
  mcpCredential,
  backupManifest,
  mutationStep,
  revisionStep,
  revisionBlob,
  job,
  workspaceOperation,
  workspaceOperationStep,
  auditEntry,
  appSettings,
  registryCache,
};
