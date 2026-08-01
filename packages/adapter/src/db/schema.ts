import { sql } from "drizzle-orm";
import {
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

const actors = ["user", "agent", "cli-external", "system"] as const;
const actorCheck = (column: { getSQL(): unknown }) =>
  sql`${column} IN ('user', 'agent', 'cli-external', 'system')`;

export const projectRegistry = sqliteTable("project_registry", {
  id: text().primaryKey(),
  workspaceRoot: text("workspace_root").notNull(),
  slug: text().notNull(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  uniqueIndex("uq_project_location").on(table.workspaceRoot, table.slug),
  index("idx_project_last_seen").on(table.lastSeenAt),
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
  kind: text({ enum: ["file", "entity"] }).notNull(),
  path: text(),
  entity: text(),
  fromHash: text("from_hash"),
  previousContent: blob("previous_content", { mode: "buffer" }),
  previousByteSize: integer("previous_byte_size").notNull().default(0),
  stagedTmpPath: text("staged_tmp_path"),
  stagedTargetPath: text("staged_target_path"),
  stagedContentHash: text("staged_content_hash"),
  toHash: text("to_hash").notNull(),
  status: text({ enum: ["pending", "committed", "aborted", "recovered", "orphaned"] }).notNull().default("pending"),
  actor: text({ enum: actors }).notNull(),
  createdAt: text("created_at").notNull(),
  settledAt: text("settled_at"),
}, (table) => [
  index("idx_journal_project").on(table.projectId),
  index("idx_journal_pending").on(table.status, table.createdAt),
  check("ck_journal_kind", sql`${table.kind} IN ('file', 'entity')`),
  check("ck_journal_status", sql`${table.status} IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned')`),
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
  type: text({ enum: ["file.changed", "project.changed", "job.progress", "job.done"] }).notNull(),
  projectId: text("project_id").references(() => projectRegistry.id),
  payload: text().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_event_type").on(table.type),
  index("idx_event_project").on(table.projectId),
  index("idx_event_created").on(table.createdAt),
  check("ck_event_type", sql`${table.type} IN ('file.changed', 'project.changed', 'job.progress', 'job.done')`),
]);

export const revision = sqliteTable("revision", {
  id: integer().primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projectRegistry.id),
  kind: text({ enum: ["file", "entity"] }).notNull(),
  path: text(),
  entity: text(),
  contentHash: text("content_hash").notNull(),
  parentRevision: integer("parent_revision"),
  actor: text({ enum: actors }).notNull(),
  summary: text(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_revision_project_created").on(table.projectId, table.createdAt),
  foreignKey({ columns: [table.parentRevision], foreignColumns: [table.id] }),
  check("ck_revision_kind", sql`${table.kind} IN ('file', 'entity')`),
  check("ck_revision_actor", actorCheck(table.actor)),
]);

export const revisionBlob = sqliteTable("revision_blob", {
  revisionId: integer("revision_id").primaryKey().references(() => revision.id, { onDelete: "cascade" }),
  previousContent: blob("previous_content", { mode: "buffer" }),
  byteSize: integer("byte_size").notNull(),
}, (table) => [check("ck_revision_blob_size", sql`${table.byteSize} >= 0`)]);

export const job = sqliteTable("job", {
  id: text().primaryKey(),
  projectId: text("project_id").references(() => projectRegistry.id),
  type: text().notNull(),
  status: text({ enum: ["queued", "running", "succeeded", "failed", "cancelled"] }).notNull().default("queued"),
  input: text().notNull(),
  progress: real().notNull().default(0),
  stage: text(),
  result: text(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
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
  uniqueIndex("uq_job_idempotency").on(table.projectId, table.type, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
  check("ck_job_progress", sql`${table.progress} BETWEEN 0 AND 1`),
  check("ck_job_attempt", sql`${table.attempt} >= 0`),
  check("ck_job_status", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
  check("ck_job_cancel", sql`${table.cancelRequested} IN (0, 1)`),
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
  revisionBlob,
  job,
  auditEntry,
  appSettings,
  registryCache,
};
