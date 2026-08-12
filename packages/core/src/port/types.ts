import type {
  Actor,
  ContentHash,
  Diagnostic,
  DomainEvent,
  Era,
  ErrorCode,
  JobDto,
  JobWarningDto,
  PreviewSettingsPatchDto,
  PreviewSettingsDto,
  ProjectId,
  RelPath,
  ToolLevel,
} from "@vidcom/contracts";

import type { AbsolutePath, ProjectRef } from "../domain/models";

/** Resolved filesystem capability created only by a WorkspacePort implementation. */
export type ResolvedPath = string & { readonly __brand: "ResolvedPath" };

/** Pure or filesystem-backed reason a requested path was rejected. */
export type PathRejection = {
  reason: "outside_project" | "not_allowed_for_purpose" | "symlink_escape" | "invalid_syntax";
};

/** Supported read purposes for project paths. */
export type ReadPurpose = "read-source" | "read-asset";

/** Supported write purposes for project paths. */
export type WritePurpose =
  | "write-source"
  | "write-asset"
  | "system-write"
  | "state-write"
  | "workspace-agent-kit";

/** Purpose-scoped capability requested from the workspace adapter. */
export type PathPurpose = ReadPurpose | WritePurpose;

/** HyperFrames CLI version bundled and contract-tested by the render pipeline. */
export const HYPERFRAMES_EXPECTED_VERSION = "0.7.86";

/** Stable journal row identity. */
export type JournalId = number & { readonly __brand: "JournalId" };

/** Stable workspace-operation row identity. */
export type WorkspaceOperationId = number & { readonly __brand: "WorkspaceOperationId" };

export type WorkspaceOperationKind =
  | "agent_kit_files"
  | "project_create"
  | "project_rename"
  | "project_delete"
  | "project_import";

export interface WorkspaceOperationIntent {
  workspaceRoot: AbsolutePath;
  kind: WorkspaceOperationKind;
  projectId: ProjectId | null;
  fromPath: string | null;
  toPath: string | null;
  stagingPath: string | null;
  backupId?: string | null;
  grantId?: string | null;
  actor: Actor;
  action: string;
  toolAudit?: PendingToolAudit | null;
}

export interface WorkspaceOperationStepIntent {
  ordinal: number;
  path: RelPath;
  fromHash: ContentHash | null;
  toHash: ContentHash | null;
  previousContent: string | Uint8Array | null;
}

export interface WorkspaceOperationStepState extends WorkspaceOperationStepIntent {
  rollbackPath: ResolvedPath | null;
  capturedHash: ContentHash | null;
  captureState: "pending" | "captured";
  status: "pending" | "written" | "rolled_back";
}

export interface PendingWorkspaceOperation extends WorkspaceOperationIntent {
  id: WorkspaceOperationId;
  status: "pending" | "orphaned" | "committed" | "recovered";
  steps: WorkspaceOperationStepState[];
}

export type ProjectLifecycleCommit =
  | {
      kind: "create";
      projectId: ProjectId;
      workspaceRoot: AbsolutePath;
      slug: string;
      actor: Actor;
      manifestHash: ContentHash;
      previewSettingsHash: ContentHash;
      occurredAt: string;
    }
  | {
      kind: "rename";
      projectId: ProjectId | null;
      workspaceRoot: AbsolutePath;
      fromSlug: string;
      toSlug: string;
      actor: Actor;
      occurredAt: string;
    }
  | {
      kind: "delete";
      projectId: ProjectId | null;
      workspaceRoot: AbsolutePath;
      slug: string;
      backupId: string;
      actor: Actor;
      occurredAt: string;
    };

export interface WorkspaceWriteEnvelope {
  operationId: WorkspaceOperationId;
  fileHashes: Record<RelPath, ContentHash>;
}

/** Redacted MCP invocation context persisted before a workspace write begins. */
export interface PendingToolAudit {
  schemaVersion: 1;
  invocationId: string;
  tool: string;
  level: ToolLevel;
  projectId: ProjectId | null;
  era: Era;
  protocolVersion: string;
  detail: Record<string, unknown>;
  credentialId: string | null;
  invokedAt: string;
  revisionBefore: number | null;
}

/** Terminal MCP invocation data written to the app-data audit repository. */
export interface ToolAuditEntry {
  tool: string;
  level: ToolLevel;
  projectId: ProjectId | null;
  era: Era;
  protocolVersion: string;
  outcome: "ok" | "error";
  errorCode: ErrorCode | null;
  detail: Record<string, unknown>;
  credentialId: string | null;
  invokedAt: string;
  durationMs: number;
  revisionBefore: number | null;
  revisionAfter: number | null;
}

/** Redacted CLI command context durably owned by a composite journal. */
export type PendingCommandAudit =
  | { action: "cli:restore"; detail: { backupId: string } }
  | {
      action: "derived.write";
      detail: { producedByJobId: JobId | null; computedAtSourceRevision: number };
    };

/** Immutable destructive-plan binding approved outside the MCP capability boundary. */
export interface GrantBinding {
  tool: string;
  projectId: ProjectId | null;
  target: string;
  expectedRevision: number;
  planDigest: string;
  targetHashes: Record<RelPath, ContentHash>;
}

/** Requested atomic approval transition executed by the persistence adapter. */
export type GrantTransition =
  | { kind: "reserve"; grantId: string; binding: GrantBinding }
  | { kind: "consume"; grantId: string }
  | { kind: "release"; grantId: string }
  | {
      kind: "invalidate";
      grantId: string;
      reason: "orphaned" | "rollback_failed";
    };

/** One caller-authored operation in a composite workspace mutation. */
/** App-data file source whose digest was computed without loading the whole file into memory. */
export interface StagedFileSource {
  sourcePath: AbsolutePath;
  contentHash: ContentHash;
}

export type CompositeStep =
  | {
      kind: "write";
      path: RelPath;
      content: string | Uint8Array | StagedFileSource;
      expectedContentHash: ContentHash | null;
    }
  | {
      kind: "delete";
      path: RelPath;
      expectedContentHash: ContentHash;
    }
  | {
      kind: "entity";
      entity: "preview-settings";
      patch: PreviewSettingsPatchDto;
      expectedRevision: number;
    };

/** Complete mutation request held under one project lease and mutex. */
export interface CompositeRequest {
  ref: ProjectRef;
  steps: CompositeStep[];
  toolAudit: PendingToolAudit | null;
  /** See `WriteInvocation.noteUnchanged`; carried so composite callers keep the signal. */
  noteUnchanged?: () => void;
  commandAudit?: PendingCommandAudit;
  diagnostics?: Diagnostic[];
  backup: boolean;
  grant?: { id: string; binding: GrantBinding };
}

interface DurableStepState {
  ordinal: number;
  fromHash: ContentHash | null;
  previousContent: string | Uint8Array | null;
}

/** Canonical, precondition-checked step persisted before filesystem I/O begins. */
export type StepIntent = DurableStepState & (
  | {
      kind: "write";
      path: RelPath;
      entity: null;
      toHash: ContentHash;
    }
  | {
      kind: "delete";
      path: RelPath;
      entity: null;
      toHash: null;
    }
  | {
      kind: "entity";
      path: null;
      entity: "preview-settings";
      toHash: ContentHash;
    }
);

/** Applied step state passed to a terminal journal transaction in ordinal order. */
export type StepResult = StepIntent & {
  status: "written" | "rolled_back";
};

/** Durable redacted context owned by an unresolved mutation journal. */
export interface PendingMutationContext {
  toolAudit: PendingToolAudit | null;
  commandAudit?: PendingCommandAudit;
}

/** Journal parent data persisted before any ordered mutation step. */
export interface CompositeIntent {
  projectId: ProjectId;
  actor: Actor;
}

/** Terminal composite data committed with revision, audit and event records. */
export interface CompositeResult extends CompositeIntent {
  steps: StepResult[];
  event: DomainEvent;
  diagnostics: Diagnostic[];
  /** Marks a T2b replay so the journal can annotate its durable tool audit atomically. */
  recovered?: boolean;
}

/** Durable composite mutation state used by startup and admin recovery. */
export interface PendingCompositeMutation extends CompositeIntent {
  id: JournalId;
  status: "pending" | "orphaned";
  steps: StepIntent[];
  context: PendingMutationContext;
  grantId: string | null;
  backupId: string | null;
}

/** Durable filesystem capture owned by one journal step at the publish boundary. */
export interface MutationCapture {
  journalId: JournalId | WorkspaceOperationId;
  ordinal: number;
  target: ResolvedPath;
  rollbackPath: ResolvedPath | null;
  capturedHash: ContentHash | null;
}

/** Precondition mismatch observed while atomically capturing the live target. */
export interface MutationCaptureConflict {
  actualHash: ContentHash | null;
}

/** Exact durable lease identity that T1 must validate before opening a mutation journal. */
export interface MutationAuthority {
  leaseId: string;
}

/** Terminal decision returned by one deterministic journal reconciliation attempt. */
export type CompositeReconcileOutcome =
  | { terminal: "committed"; envelope: WriteEnvelope }
  | { terminal: "aborted" | "rolled_back" | "orphaned" };

/** One integrity-checked file described by a published backup manifest. */
export interface BackupManifestEntry {
  path: RelPath;
  contentHash: ContentHash;
  byteSize: number;
}

/** Resolved workspace capability supplied to the backup adapter for reading. */
export interface BackupSource {
  path: RelPath;
  resolved: ResolvedPath;
}

/** Verified backup bytes returned to a Core restore use case. */
export interface BackupPayload {
  path: RelPath;
  bytes: Uint8Array;
  contentHash: ContentHash;
}

/** Durable backup metadata retained after its restorable payload is pruned. */
interface BackupManifestBase {
  id: string;
  revisionId: number | null;
  createdAt: string;
  reason: string;
  entries: BackupManifestEntry[];
  manifestHash: string;
  payloadPrunedAt: string | null;
}

export interface BackupManifest extends BackupManifestBase {
  projectId: ProjectId | null;
  workspaceRoot?: AbsolutePath | null;
  slug?: string | null;
}

/** Durable approval row visible to Core without exposing adapter transaction types. */
export interface ApprovalGrantRecord {
  id: string;
  binding: GrantBinding;
  summary: string;
  status: "requested" | "issued" | "reserved" | "consumed" | "expired" | "revoked" | "invalidated";
  approver: "ui" | "cli" | null;
  createdAt: string;
  expiresAt: string;
}

/** Non-secret MCP credential metadata stored in application data. */
export interface McpCredentialRecord {
  id: string;
  label: string;
  secretHash: ContentHash;
  status: "active" | "rotating" | "revoked";
  createdAt: string;
  rotatedFrom: string | null;
  expiresAt: string | null;
}

/** Public credential lifecycle metadata; verifier material never crosses this boundary. */
export type McpCredentialSummary = Omit<McpCredentialRecord, "secretHash">;

/** Optional SDK-neutral context forwarded from a tool registry into write authority. */
export interface WriteInvocation {
  toolAudit: PendingToolAudit | null;
  /**
   * Called when the request was already satisfied, so no journal was opened.
   *
   * Write authority proves this rather than assuming it: every step's `fromHash`
   * equals its `toHash`, which means nothing was written and there is no journal
   * to own this invocation's audit. Without the signal a caller cannot tell that
   * apart from a handler that mutated the filesystem behind the journal's back —
   * and the registry has to treat the second case as a fault.
   */
  noteUnchanged?(): void;
}

/** Canonical mutation result across file, entity, and composite writes. */
export interface WriteEnvelope {
  projectRevision: number;
  entityRevision: number | null;
  fileHashes: Record<RelPath, ContentHash>;
  diagnostics: Diagnostic[];
}

/** Durable unresolved journal state exposed to readers and the project write gate. */
export interface ProjectRecoveryStatus {
  writeStatus: "ready" | "recovery_required";
  unresolved: Array<{
    journalId: JournalId;
    status: "pending" | "orphaned";
  }>;
}

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
export type StoredEvent = DomainEvent & { seq: number };

/** Stable job identity. */
export type JobId = string & { readonly __brand: "JobId" };

/** Ordered SQLite revision row used only to rebuild the human-readable projection. */
export interface ProjectRevisionProjection {
  revision: number;
  sourceRevision: number;
  actor: Actor;
  createdAt: string;
  paths: RelPath[];
  summary: string;
}

/** Internal durable job record consumed by Core scheduling logic. */
export interface Job extends JobDto {
  /** Null only while a workspace-scoped job has not produced a project yet. */
  projectId: ProjectId | null;
  input: unknown;
  inputHash: ContentHash;
  idempotencyKey: string | null;
  cancelRequested: boolean;
  workerId: string | null;
  heartbeatAt: string | null;
  terminationProof?: import("./process-port").ProcessTerminationProof | null;
}

/** New job data ready for durable enqueue. */
export interface NewJob {
  id: JobId;
  /** Null only for workspace-scoped jobs such as project import. */
  projectId: ProjectId | null;
  type: string;
  input: unknown;
  inputHash: ContentHash;
  idempotencyKey: string | null;
}

/** Terminal outcome persisted for a job. */
export type JobOutcome =
  (| { status: "succeeded"; result: unknown }
   | { status: "partial"; result: unknown }
   | { status: "failed"; error: { code: ErrorCode; message: string } }
   | { status: "cancelled" })
  & {
    warnings?: readonly JobWarningDto[];
    cleanupPending?: boolean;
    terminationProof?: import("./process-port").ProcessTerminationProof;
  };

/** Preview settings shape accepted by the composition adapter. */
export type PreviewSettings = PreviewSettingsDto;
