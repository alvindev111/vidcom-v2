import type {
  ContentHash,
  Diagnostic,
  DomainError,
  DomainEvent,
  ErrorCode,
  JobWarningDto,
  ProjectId,
  RelPath,
} from "@vidcom/contracts";

import type { AbsolutePath, BinaryContent, CompositionModel, CompositionOp, FileContent, FileNode, FileStat, ProjectRef } from "../domain/models";
import type { MotionLibrary } from "../domain/motion-libraries";
import type { Result } from "../error/result";
import type {
  Job,
  JobId,
  JobOutcome,
  JournalId,
  LeaseInfo,
  MutationIntent,
  MutationResult,
  NewJob,
  EntityState,
  EntitySeed,
  PathPurpose,
  PathRejection,
  PendingMutation,
  ProjectRegistration,
  PreviewSettings,
  ResolvedPath,
  StoredEvent,
  CompositeIntent,
  CompositeResult,
  GrantTransition,
  PendingCompositeMutation,
  PendingMutationContext,
  ProjectRecoveryStatus,
  StepIntent,
  ToolAuditEntry,
  WriteEnvelope,
  ApprovalGrantRecord,
  BackupManifest,
  BackupPayload,
  BackupSource,
  GrantBinding,
  McpCredentialRecord,
  MutationCapture,
  MutationCaptureConflict,
  MutationAuthority,
  PendingWorkspaceOperation,
  WorkspaceOperationId,
  WorkspaceOperationIntent,
  WorkspaceOperationStepIntent,
  StagedFileSource,
} from "./types";

/** Durable journal for root-workspace and project-directory operations. */
export interface WorkspaceOperationJournalPort {
  isJournalOwned(invocationId: string): Promise<boolean>;
  begin(
    intent: WorkspaceOperationIntent,
    steps: WorkspaceOperationStepIntent[],
    authority: MutationAuthority,
  ): Promise<WorkspaceOperationId>;
  markStepCaptured(
    id: WorkspaceOperationId,
    ordinal: number,
    rollbackPath: ResolvedPath | null,
    capturedHash: ContentHash | null,
  ): Promise<void>;
  markStepWritten(id: WorkspaceOperationId, ordinal: number): Promise<void>;
  commit(id: WorkspaceOperationId): Promise<void>;
  setDirectoryPaths(
    id: WorkspaceOperationId,
    paths: { fromPath?: string | null; toPath?: string | null; stagingPath?: string | null },
  ): Promise<void>;
  commitProjectLifecycle(
    id: WorkspaceOperationId,
    result: import("./types").ProjectLifecycleCommit,
    recovered?: boolean,
  ): Promise<number | null>;
  recover(id: WorkspaceOperationId): Promise<void>;
  abort(id: WorkspaceOperationId, reason: ErrorCode): Promise<void>;
  rollback(id: WorkspaceOperationId, reason: ErrorCode): Promise<void>;
  orphan(id: WorkspaceOperationId, reason: ErrorCode): Promise<void>;
  read(id: WorkspaceOperationId): Promise<PendingWorkspaceOperation | null>;
  listPending(workspaceRoot: AbsolutePath): Promise<PendingWorkspaceOperation[]>;
  completeDirectoryCleanup(id: WorkspaceOperationId): Promise<void>;
}

/** Filesystem-only directory lifecycle boundary; Core never joins or removes native paths. */
export interface ProjectDirectoryPort {
  projectRoot(workspaceRoot: AbsolutePath, slug: string): Promise<AbsolutePath>;
  createPaths(
    workspaceRoot: AbsolutePath,
    slug: string,
    operationId: WorkspaceOperationId,
  ): Promise<{ stagingRoot: AbsolutePath; finalRoot: AbsolutePath }>;
  stageCreate(
    workspaceRoot: AbsolutePath,
    slug: string,
    operationId: WorkspaceOperationId,
  ): Promise<{ stagingRoot: AbsolutePath; finalRoot: AbsolutePath }>;
  writeStagedFiles(
    stagingRoot: AbsolutePath,
    files: Array<{ path: RelPath; content: string | Uint8Array }>,
  ): Promise<void>;
  publishCreate(stagingRoot: AbsolutePath, finalRoot: AbsolutePath): Promise<void>;
  rename(from: AbsolutePath, to: AbsolutePath): Promise<void>;
  quarantine(root: AbsolutePath, operationId: WorkspaceOperationId): Promise<AbsolutePath>;
  quarantinePath(root: AbsolutePath, operationId: WorkspaceOperationId): Promise<AbsolutePath>;
  restoreQuarantine(quarantine: AbsolutePath, root: AbsolutePath): Promise<void>;
  removeOwned(path: AbsolutePath): Promise<void>;
  inspect(path: AbsolutePath): Promise<"absent" | "directory" | "invalid">;
}

export interface RenderRootPort {
  acquire(jobId: JobId): Promise<{ root: AbsolutePath; environment: Record<string, string> }>;
  release(jobId: JobId): Promise<{ ok: boolean; error?: string }>;
  inspect(jobId: JobId): Promise<"absent" | "owned" | "unowned">;
  reclaimOrphans(
    now: Date,
    runningJobIds: ReadonlySet<JobId>,
  ): Promise<{ deleted: number; reclaimedJobIds: JobId[]; errors: Array<{ root: string; reason: string }> }>;
}

/** Filesystem capability that prepares a guarded, disposable HyperFrames project clone. */
export interface RenderProjectPort {
  stage(
    ref: ProjectRef,
    renderRoot: AbsolutePath,
    document: string,
    runtimeSource: string,
  ): Promise<{ projectRoot: AbsolutePath; outputPath: AbsolutePath; snapshotOutputRoot: AbsolutePath }>;
  artifactSource(outputPath: AbsolutePath): Promise<StagedFileSource>;
  readSnapshotArtifacts(outputRoot: AbsolutePath): Promise<Array<{ name: string; content: Uint8Array }>>;
  composeContactSheet(images: readonly Uint8Array[]): Promise<Uint8Array>;
}

export interface RenderBinaryProbeResult {
  /**
   * Executable plus its arguments, already in the right shape to spawn.
   *
   * Not a fixed pair: a packaged artifact has to pass an internal sentinel
   * before the script path, because its execPath is the vidcom binary rather
   * than node.
   */
  hyperframesCommand: readonly [string, ...string[]];
  browserPath: AbsolutePath;
  ffmpegPath: AbsolutePath;
  ffprobePath: AbsolutePath;
  warnings: JobWarningDto[];
}

export interface BinaryProbePort {
  probe(): Promise<Result<RenderBinaryProbeResult, DomainError>>;
}

/** Adapter-owned HyperFrames check execution; non-zero finding exits remain available results. */
export interface DiagnosticsLintPort {
  check(ref: ProjectRef): Promise<{ available: boolean; diagnostics: Diagnostic[] }>;
}

/** Reads a pinned motion library's source from wherever the adapter installs it. */
export interface MotionLibraryFilesPort {
  read(library: MotionLibrary): Promise<Result<Array<{ projectPath: RelPath; content: string }>, DomainError>>;
}

/** Filesystem access for the selected workspace; every method performs I/O. */
export interface WorkspacePort {
  /** Lists direct child directories only; classification and ignore rules stay in Core. */
  listWorkspaceDirectories?(root: AbsolutePath): Promise<Array<{ slug: string; root: AbsolutePath }>>;
  /** Resolves and authorizes a path; supports missing targets and returns rejection without throwing. */
  resolve(ref: ProjectRef, path: string, purpose: PathPurpose): Promise<Result<ResolvedPath, PathRejection>>;
  /** Resolves an agent-kit path against the exact injected workspace root; only the workspace coordinator calls this. */
  resolveWorkspace(
    workspaceRoot: AbsolutePath,
    path: RelPath,
    purpose: "workspace-agent-kit",
  ): Promise<Result<ResolvedPath, PathRejection>>;
  /** Lists valid projects from workspace storage; this may be an expensive directory traversal. */
  listProjects(): Promise<ProjectRef[]>;
  /** Reads one project identity; `null` means the project does not exist. */
  readProjectRef(id: ProjectId): Promise<ProjectRef | null>;
  /** Reads one resolved file; `null` means the file does not exist. */
  readFile(path: ResolvedPath): Promise<FileContent | null>;
  /** Reads arbitrary allowlisted bytes; `null` means the file does not exist. */
  readBytes(path: ResolvedPath): Promise<BinaryContent | null>;
  /** Hashes one resolved file; `null` means the file does not exist and hashing performs I/O. */
  readHash(path: ResolvedPath): Promise<ContentHash | null>;
  /** Atomically writes a resolved path; no precondition is checked by this method. */
  writeAtomic(path: ResolvedPath, content: string | Uint8Array): Promise<void>;
  /** Appends one already-serialized line durably without creating a project revision. */
  appendAtomic?(path: ResolvedPath, line: string): Promise<void>;
  /** Checks one resolved capability using filesystem I/O; `false` means the target is absent. */
  exists(path: ResolvedPath): Promise<boolean>;
  /** Atomically removes one resolved file and fsyncs its directory; an absent target is a no-op. */
  deleteAtomic(path: ResolvedPath): Promise<void>;
  /** Moves the live target into a journal-owned rollback slot and verifies its hash at that exact boundary. */
  captureForMutation(
    path: ResolvedPath,
    expectedHash: ContentHash | null,
    journalId: JournalId | WorkspaceOperationId,
    ordinal: number,
  ): Promise<Result<MutationCapture, MutationCaptureConflict>>;
  /** Publishes staged bytes without replacing a target created after capture; `null` verifies a delete remains absent. */
  publishCaptured(capture: MutationCapture, content: string | Uint8Array | null): Promise<boolean>;
  /** Restores captured bytes only while the live target still matches the supplied landed hash. */
  restoreCaptured(capture: MutationCapture, landedHash: ContentHash | null): Promise<boolean>;
  /** Removes a terminal mutation's rollback slot after SQLite commit or verified abort. */
  discardCapture(capture: MutationCapture): Promise<void>;
  /** Reads the complete project tree and may be expensive for large projects. */
  readTree(ref: ProjectRef): Promise<FileNode[]>;
  /** Reads metadata for a resolved path; `null` means the path does not exist. */
  stat(path: ResolvedPath): Promise<FileStat | null>;
  /** Stats one scanner-owned marker without opening a general path-policy bypass. */
  statWorkspaceFile?(root: AbsolutePath, path: "vidcom.json" | "hyperframes.json" | "index.html"):
    Promise<{ size: number; modifiedAtMs: number } | null>;
  /** Reads one scanner-owned marker without opening a general path-policy bypass. */
  readWorkspaceFile?(root: AbsolutePath, path: "vidcom.json" | "hyperframes.json" | "index.html"):
    Promise<FileContent | null>;
  /** Lists regular files immediately below one allowlisted `.vidcom` directory. */
  listProjectFiles?(ref: ProjectRef, directory: RelPath):
    Promise<Array<{ path: RelPath; modifiedAtMs: number }>>;
  /** Creates only the fixed `.vidcom` directory skeleton; files still go through authority/append. */
  ensureProjectStateDirectories?(ref: ProjectRef): Promise<void>;
  /** Enumerates every regular project file as a contained read capability for verified deletion backup. */
  listBackupSources?(ref: ProjectRef): Promise<BackupSource[]>;
  /** Same closed read capability for a session-scoped recovery root that has no ProjectId. */
  listBackupSourcesAt?(root: AbsolutePath): Promise<BackupSource[]>;
}

export interface StagedAsset {
  temporaryPath: string;
  targetPath: RelPath;
  contentHash: ContentHash;
  commit(): Promise<void>;
  cleanup(): Promise<void>;
}

/** App-data staging boundary for a no-overwrite composite asset mutation. */
export interface StagedAssetPort {
  stage(target: ResolvedPath, targetPath: RelPath, bytes: Uint8Array): Promise<StagedAsset>;
  stageFile(
    target: ResolvedPath,
    targetPath: RelPath,
    sourcePath: AbsolutePath,
    expectedHash: ContentHash,
  ): Promise<StagedAsset>;
}

/** HyperFrames parsing and mutation operations; parsing and document builds are expensive. */
export interface CompositionPort {
  /** Parses one project into the shared composition model and performs adapter I/O. */
  parseProject(ref: ProjectRef): Promise<CompositionModel>;
  /** Builds the sole preview document representation and performs adapter I/O. */
  buildDocument(
    ref: ProjectRef,
    settings: PreviewSettings,
    options: { root: boolean; runtimeUrl?: string; fileBaseUrl?: string },
  ): Promise<string>;
  /** Applies SDK operations in memory without writing the resulting HTML to disk. */
  applyOps(ref: ProjectRef, file: RelPath, ops: CompositionOp[]): Promise<Result<string, DomainError>>;
  /** Validates authored source in memory before the write authority persists it. */
  validateSource?(file: RelPath, content: string): Promise<Result<void, DomainError>>;
}

/** Durable unit of work joining mutation, revision, audit, entity and event records. */
export interface MutationJournalPort {
  /** Persists a pending intent before filesystem I/O and returns its durable ID. */
  begin(intent: MutationIntent): Promise<JournalId>;
  /** Atomically commits all mutation-owned database rows and returns the assigned revision. */
  commit(id: JournalId, result: MutationResult): Promise<number>;
  /** Marks an intent aborted with its stable reason; this performs database I/O. */
  abort(id: JournalId, reason: ErrorCode): Promise<void>;
  /** Lists every pending row for startup recovery; an empty list means none exist. */
  listPending(): Promise<PendingMutation[]>;
  /** Reads the latest project mutation revision; `null` means no mutation has committed. */
  latestRevision(projectId: ProjectId): Promise<number | null>;
  /** Reads the newest revision that advances authored render input. */
  latestSourceRevision(projectId: ProjectId): Promise<number | null>;
  /** Lists ordered SQLite revision rows for one-way `.vidcom` projection rebuild. */
  listProjectRevisions?(projectId: ProjectId): Promise<import("./types").ProjectRevisionProjection[]>;
  /** Reads one committed rollback slot and distinguishes retention pruning from an absent prior file. */
  readRevisionRollbackPayload(
    revisionId: number,
    path: RelPath,
  ): Promise<Result<Uint8Array | null, DomainError>>;
  /** Reads entity precondition state; `null` means bootstrap has not seeded it. */
  readEntityState(projectId: ProjectId, entity: "preview-settings"): Promise<EntityState | null>;
  /** Reads one identity registration; `null` means this ID has never been registered. */
  findProjectRegistration(projectId: ProjectId): Promise<ProjectRegistration | null>;
  /** Reads an active identity registration at one workspace location without minting an ID. */
  findProjectRegistrationAt?(workspaceRoot: AbsolutePath, slug: string): Promise<ProjectRegistration | null>;
  /** Upserts location and seeds entity state atomically when no identity file write is needed. */
  registerProject(registration: ProjectRegistration, seed: EntitySeed): Promise<void>;
  /** Atomically registers identity, seeds entity state and inserts pending journal before filesystem I/O. */
  beginBootstrap(
    registration: ProjectRegistration,
    seed: EntitySeed,
    intent: MutationIntent,
    duplicateFrom: ProjectId | null,
  ): Promise<JournalId>;
  /** Recovers a completed filesystem write and marks the journal `recovered` atomically. */
  recover(id: JournalId, result: MutationResult): Promise<number>;
  /** Marks an ambiguous pending mutation orphaned and records all observed hashes. */
  orphan(id: JournalId, actualHash: ContentHash | null): Promise<void>;
}

/** Composite journal operations implemented atomically by one persistence adapter. */
export interface CompositeMutationJournalPort extends MutationJournalPort {
  /** Persists a parent, ordered steps, redacted context and optional grant reserve in one transaction. */
  beginComposite(
    intent: CompositeIntent,
    steps: StepIntent[],
    context: PendingMutationContext,
    authority: MutationAuthority,
    grant?: Extract<GrantTransition, { kind: "reserve" }>,
  ): Promise<JournalId>;
  /** Persists the exact rollback slot and captured hash before a step can publish. */
  markStepCaptured(
    id: JournalId,
    ordinal: number,
    rollbackPath: ResolvedPath | null,
    capturedHash: ContentHash | null,
  ): Promise<void>;
  /** Durably links a verified backup and enriches pending audit context before filesystem I/O. */
  attachBackup(id: JournalId, backupId: string): Promise<void>;
  /** Atomically commits revision steps, mutation/tool audits, event and optional grant consumption. */
  commitComposite(
    id: JournalId,
    result: CompositeResult,
    grant?: Extract<GrantTransition, { kind: "consume" }>,
  ): Promise<WriteEnvelope>;
  /** Commits derived artifacts without advancing the authored source revision. */
  commitDerivedComposite(id: JournalId, result: CompositeResult): Promise<WriteEnvelope>;
  /** Atomically aborts a journal and releases its grant, returning context for failure audit or `null` after a prior terminal transition. */
  abortComposite(
    id: JournalId,
    reason: ErrorCode,
    grant?: Extract<GrantTransition, { kind: "release" }>,
  ): Promise<PendingMutationContext | null>;
  /** Atomically marks a verified mixed-step restoration rolled back and releases its exact grant. */
  rollbackComposite(
    id: JournalId,
    reason: ErrorCode,
    grant?: Extract<GrantTransition, { kind: "release" }>,
  ): Promise<PendingMutationContext | null>;
  /** Finalizes an explicitly verified restore of one orphan without altering its invalidated grant. */
  resolveOrphanedRestore(id: JournalId, actor: "cli-external"): Promise<void>;
  /** Commits an explicitly validated current orphan state as a reconciliation revision. */
  resolveOrphanedAccept(id: JournalId, result: CompositeResult): Promise<WriteEnvelope>;
  /** Atomically records an unrecoverable state, its error audit and optional grant invalidation. */
  orphanComposite(
    id: JournalId,
    reason: ErrorCode,
    grant?: Extract<GrantTransition, { kind: "invalidate" }>,
  ): Promise<void>;
  /** Reads ordered durable steps for one journal; an empty array means the journal has no step rows. */
  readSteps(id: JournalId): Promise<StepIntent[]>;
  /** Reads the destructive revision steps linked to one exact backup, in ordinal order. */
  readBackupRevisionSteps(backupId: string, revisionId: number): Promise<StepIntent[]>;
  /** Reads one unresolved composite and its exact durable context, or `null` when absent or terminal. */
  readPendingComposite(id: JournalId): Promise<PendingCompositeMutation | null>;
  /** Lists unresolved journals registered inside one exact leased workspace root. */
  listPendingComposites(workspaceRoot: string): Promise<PendingCompositeMutation[]>;
  /** Returns whether an unresolved journal owns the invocation, without exposing its redacted audit payload. */
  isJournalOwned(invocationId: string): Promise<boolean>;
  /** Reads all unresolved journal IDs for a project; an empty list means writes are ready. */
  readProjectRecoveryStatus(projectId: ProjectId): Promise<ProjectRecoveryStatus>;
  /** Throws a domain-coded persistence error when any unresolved journal currently gates project writes. */
  assertProjectWritable(projectId: ProjectId): Promise<void>;
}

/** Application-data backup storage; every method performs filesystem and/or metadata I/O. */
export interface BackupPort {
  /** Atomically publishes a verified backup, or throws without publishing a manifest on failure. */
  create(projectId: ProjectId, reason: string, files: BackupSource[]): Promise<BackupManifest>;
  /** Publishes a verified backup for an identity-invalid location without persisting its entryId. */
  createForLocation?(
    owner: { workspaceRoot: AbsolutePath; slug: string },
    reason: string,
    files: BackupSource[],
  ): Promise<BackupManifest>;
  /** Reads durable metadata; `null` means the backup ID has never existed. */
  read(id: string): Promise<BackupManifest | null>;
  /** Reads all retained payload bytes; an empty array means the manifest has no entries. */
  readPayloads(id: string): Promise<BackupPayload[]>;
  /** Re-hashes every retained payload; `false` means content is missing or corrupt. */
  verify(id: string): Promise<boolean>;
  /** Lists project manifests in deterministic creation order; an empty list means none exist. */
  list(projectId: ProjectId): Promise<BackupManifest[]>;
  /** Deletes payload bytes older than the cutoff while retaining metadata and returns the pruned count. */
  prunePayloads(olderThan: Date): Promise<number>;
  /** Removes unreferenced published/temp backup directories older than the crash grace cutoff. */
  cleanupOrphanPayloads(olderThan: Date): Promise<number>;
}

/** Durable approval request operations outside journal-owned reserve/finalize transactions. */
export interface ApprovalGrantPort {
  /** Inserts one requested grant and performs database I/O. */
  create(record: ApprovalGrantRecord): Promise<void>;
  /** Reads one grant; `null` means the ID has never existed. */
  read(id: string): Promise<ApprovalGrantRecord | null>;
  /** Atomically issues an unexpired request; `null` means status or expiry no longer permits issuance. */
  issue(id: string, approver: "ui" | "cli", issuedAt: string, expiresAt: string): Promise<ApprovalGrantRecord | null>;
  /** Atomically revokes an issued grant; `false` means another transition already won. */
  revoke(id: string): Promise<boolean>;
  /** Validates the current durable row against a canonical binding without changing grant state. */
  matches(id: string, binding: GrantBinding, now: string): Promise<boolean>;
  /** Transitions due requested/issued rows to expired while leaving journal-owned reserved rows untouched. */
  expireDue(now: string): Promise<number>;
  /** Deletes terminal grants older than the cutoff while preserving every unresolved journal link. */
  cleanupTerminal(expiresBefore: string): Promise<number>;
}

/** Persistence for hashed MCP credentials; plaintext secrets never cross this boundary. */
export interface McpCredentialPort {
  /** Inserts non-secret credential metadata and performs database I/O. */
  create(record: McpCredentialRecord): Promise<void>;
  /** Looks up an accepted credential by canonical hash; `null` means unknown or unusable. */
  findUsableByHash(secretHash: ContentHash, now: string): Promise<McpCredentialRecord | null>;
  /** Reads one credential by ID; `null` means it has never existed. */
  read(id: string): Promise<McpCredentialRecord | null>;
  /** Lists non-secret summaries in deterministic creation order. */
  list(): Promise<McpCredentialRecord[]>;
  /** Marks an active credential rotating and inserts its replacement atomically. */
  rotate(currentId: string, replacement: McpCredentialRecord, expiresAt: string): Promise<boolean>;
  /** Revokes one active or rotating credential; `false` means it was already terminal or absent. */
  revoke(id: string): Promise<boolean>;
}

/** Secret generation and constant-shape digest operations owned by the runtime adapter. */
export interface McpCredentialCryptoPort {
  /** Creates one high-entropy bearer and its canonical digest without persistence I/O. */
  issue(): { secret: string; secretHash: ContentHash };
  /** Validates the fixed bearer shape and returns its canonical digest, or `null` when malformed. */
  hash(secret: string): ContentHash | null;
  /** Compares two canonical digests without data-dependent early exit. */
  equals(left: ContentHash, right: ContentHash): boolean;
}

/** Counter and latency seam used by Core without depending on an observability SDK. */
export interface MetricPort {
  /** Increments a named counter in the configured metrics sink. */
  increment(name: string, attributes?: Record<string, string | number | boolean>): void;
  /** Records a millisecond observation in the configured metrics sink. */
  observeMilliseconds(name: string, value: number, attributes?: Record<string, string | number | boolean>): void;
}

/** Structured redacted logging seam; implementations decide the destination and may perform I/O. */
export interface LogPort {
  /** Emits a warning without throwing when the configured sink is unavailable. */
  warn(message: string, detail?: Record<string, unknown>): void;
  /** Emits an error without throwing when the configured sink is unavailable. */
  error(message: string, detail?: Record<string, unknown>): void;
}

/** App-data persistence for terminal MCP audit rows outside journal-owned write commits. */
export interface ToolAuditPort {
  /** Writes one already-redacted terminal row; rejection means no row was committed. */
  record(entry: ToolAuditEntry, createdAt: string): Promise<void>;
}

/** Cross-process ownership lease for one workspace. */
export interface LeasePort {
  /** Attempts durable acquisition; failure returns the current holder rather than throwing. */
  acquire(
    workspaceRoot: string,
    holderId: string,
    ttlMs: number,
  ): Promise<{ ok: true; leaseId: string } | { ok: false; heldBy: LeaseInfo }>;
  /** Renews a lease using storage I/O; `false` means ownership was lost. */
  renew(leaseId: string): Promise<boolean>;
  /** Releases a lease using storage I/O; releasing an absent lease is a no-op. */
  release(leaseId: string): Promise<void>;
  /** Checks durable ownership before a write; `false` means ownership was lost. */
  assertHeld(leaseId: string): Promise<boolean>;
}

/** In-memory local login sessions that intentionally disappear on daemon restart. */
export interface SessionPort {
  /** Creates a raw token while storing only its hash; this does not perform filesystem I/O. */
  mint(options: { absoluteTtlMs: number; idleTtlMs: number }): { token: string };
  /** Verifies and possibly renews a token; `valid: false` means no active session matches. */
  verify(token: string): { valid: boolean; renewed: boolean };
  /** Invalidates all in-memory sessions without external I/O. */
  revokeAll(): void;
}

/** Durable event source for SSE; mutation events are committed through MutationJournalPort. */
export interface EventOutboxPort {
  /** Appends an event produced outside mutation flow in its own transaction. */
  append(event: DomainEvent): Promise<number>;
  /** Reads after a sequence; `gap` means retention was exceeded and the client must resync. */
  readFrom(seq: number, limit: number): Promise<{ events: StoredEvent[]; gap: boolean }>;
  /** Reads the latest durable sequence; zero means no events have been stored. */
  latestSeq(): Promise<number>;
}

/** Durable job persistence used by the in-process scheduler. */
export interface JobStorePort {
  /** Enqueues or returns an identical prior job; a reused key with different input is a conflict. */
  enqueue(job: NewJob): Promise<{ job: Job; reused: boolean } | { conflict: "idempotency_key_reused" }>;
  /** Reads one job; `null` means the ID does not exist. */
  get(id: JobId): Promise<Job | null>;
  /** Reads durable process termination evidence without exposing internal job input. */
  readTerminationProof?(id: JobId): Promise<import("./process-port").ProcessTerminationProof | null>;
  /** Reads the newest terminal job for one project/type; `null` means no prior terminal result exists. */
  latestTerminal(projectId: ProjectId, type: string): Promise<Job | null>;
  /** Lists ordered SQLite jobs for one-way `.vidcom` projection rebuild. */
  listProjectJobs?(projectId: ProjectId): Promise<Job[]>;
  /** True only while a queued/running job currently blocks project rename or deletion. */
  hasRunningProjectJob?(projectId: ProjectId): Promise<boolean>;
  /** Claims a queued job atomically; `false` means another worker won or it is not queued. */
  claim(id: JobId, workerId: string): Promise<boolean>;
  /** Reads the oldest eligible queued job; `null` means none is ready. */
  nextQueued(
    types: string[],
    excluded: readonly { projectId: ProjectId; type: string }[],
  ): Promise<Job | null>;
  /** Persists bounded progress and an optional stage; `null` clears the stage. */
  updateProgress(id: JobId, progress: number, stage: string | null): Promise<void>;
  /** Persists a liveness timestamp for a running job. */
  heartbeat(id: JobId): Promise<void>;
  /** Persists exactly one terminal outcome; `false` means another terminal settle won. */
  finish(id: JobId, outcome: JobOutcome): Promise<boolean>;
  /** Records cooperative cancellation; terminal jobs remain unchanged. */
  requestCancel(id: JobId): Promise<void>;
  /** Atomically closes the cancellation gate before an irreversible derived publication. */
  beginPublication(id: JobId): Promise<boolean>;
  /** Reads the durable cooperative-cancellation flag. */
  isCancellationRequested(id: JobId): Promise<boolean>;
  /** Requeues one stale running job after startup recovery. */
  requeue(id: JobId): Promise<void>;
  /** Lists running jobs older than cutoff; an empty list means recovery has no work. */
  listStale(cutoff: Date): Promise<Job[]>;
  /** Lists the exact live-set used by render-root orphan reclaim. */
  listRunningIds?(): Promise<JobId[]>;
  /** Lists terminal jobs whose owned render root still needs reconciliation. */
  listCleanupPendingIds?(): Promise<JobId[]>;
  /** Clears a persisted cleanup obligation only after its owned root is gone. */
  clearCleanupPending?(id: JobId): Promise<boolean>;
}

/** Injectable wall clock used to keep Core deterministic. */
export interface ClockPort {
  /** Returns the current instant without external I/O. */
  now(): Date;
}

/** Injectable deterministic-capable ID source. */
export interface IdPort {
  /** Returns a new ID in the requested namespace without performing persistence I/O. */
  newId(prefix: string): string;
}
