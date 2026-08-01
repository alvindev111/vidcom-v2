import type {
  Actor,
  ContentHash,
  DomainEvent,
  ErrorCode,
  JobDto,
  PreviewSettingsDto,
  ProjectId,
  RelPath,
} from "@vidcom/contracts";

/** Resolved filesystem capability created only by a WorkspacePort implementation. */
export type ResolvedPath = string & { readonly __brand: "ResolvedPath" };

/** Pure or filesystem-backed reason a requested path was rejected. */
export type PathRejection = {
  reason: "outside_project" | "not_allowed_for_purpose" | "symlink_escape" | "invalid_syntax";
};

/** Supported read purposes for project paths. */
export type ReadPurpose = "read-source" | "read-asset";

/** Supported write purposes for project paths. */
export type WritePurpose = "write-source" | "write-asset" | "system-write";

/** Purpose-scoped capability requested from the workspace adapter. */
export type PathPurpose = ReadPurpose | WritePurpose;

/** Stable journal row identity. */
export type JournalId = number & { readonly __brand: "JournalId" };

/** Durable intent recorded before a workspace mutation. */
export interface MutationIntent {
  projectId: ProjectId;
  kind: "file" | "entity";
  path: RelPath | null;
  entity: "preview-settings" | null;
  fromHash: ContentHash | null;
  toHash: ContentHash;
  actor: Actor;
  previousContent: string | Uint8Array | null;
  stagedAsset?: { temporaryPath: string; targetPath: RelPath; contentHash: ContentHash } | null;
}

/** Data committed atomically after a workspace mutation succeeds. */
export interface MutationResult extends MutationIntent {
  event: DomainEvent;
}

/** Pending journal entry used by startup reconciliation. */
export interface PendingMutation extends MutationIntent {
  id: JournalId;
}

/** Current revision and backing-file hash for one mutable entity. */
export interface EntityState {
  revision: number;
  contentHash: ContentHash;
  backingPath: RelPath;
}

/** Stable registry row identifying one project location. */
export interface ProjectRegistration {
  id: ProjectId;
  workspaceRoot: string;
  slug: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Initial state for the preview-settings entity during project bootstrap. */
export interface EntitySeed extends EntityState {
  actor: Actor;
  updatedAt: string;
}

/** Information about another daemon currently holding a workspace lease. */
export interface LeaseInfo {
  holderId: string;
  expiresAt: Date;
}

/** Event read from durable outbox storage. */
export interface StoredEvent extends DomainEvent {
  seq: number;
}

/** Stable job identity. */
export type JobId = string & { readonly __brand: "JobId" };

/** Internal durable job record consumed by Core scheduling logic. */
export interface Job extends JobDto {
  projectId: ProjectId;
  input: unknown;
  inputHash: ContentHash;
  idempotencyKey: string | null;
  cancelRequested: boolean;
  workerId: string | null;
  heartbeatAt: string | null;
}

/** New job data ready for durable enqueue. */
export interface NewJob {
  id: JobId;
  projectId: ProjectId;
  type: string;
  input: unknown;
  inputHash: ContentHash;
  idempotencyKey: string | null;
}

/** Terminal outcome persisted for a job. */
export type JobOutcome =
  | { status: "succeeded"; result: unknown }
  | { status: "failed"; error: { code: ErrorCode; message: string } }
  | { status: "cancelled" };

/** Preview settings shape accepted by the composition adapter. */
export type PreviewSettings = PreviewSettingsDto;
