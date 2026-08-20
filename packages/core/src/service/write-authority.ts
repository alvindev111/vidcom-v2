import {
  ErrorCode,
  PendingMountOperationIdSchema,
  type Actor,
  type ContentHash,
  type Diagnostic,
  type DomainError,
  type DomainEvent,
  type PreviewSettingsDto,
  type PreviewSettingsPatchDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { DEFAULT_PREVIEW_SETTINGS, mergePreviewSettings, normalizePreviewSettings, serializePreviewSettings } from "../domain/preview-settings";
import { checkPathPurpose } from "../domain/path-policy";
import type { AbsolutePath, ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import {
  ignoredMutationOriginForActor,
  type MutationObserverPort,
  type MutationReceipt,
  type MutationReceiptStep,
  type MutationReadGuard,
  type UndoContentPort,
  type UndoContentRef,
} from "../port/mutation-observer";
import type { BackupPort, ClockPort, CompositeMutationJournalPort, LeasePort, MutationJournalPort, PendingMountPort, ProjectPathInvalidator, StagedAssetPort, WorkspacePort, WrittenStateTrackerPort } from "../port/ports";
import type {
  CompositeRequest,
  CompositeReconcileOutcome,
  CompositeStep,
  EntityState,
  MutationCapture,
  MutationPathLease,
  PathPurpose,
  PathRejection,
  PendingMountOpen,
  PendingToolAudit,
  ResolvedPath,
  StepIntent,
  WriteEnvelope,
  WriteInvocation,
  JobId,
  StagedFileSource,
  WorkspaceWriteEnvelope,
} from "../port/types";
import type { JournalId } from "../port/types";
import { canonicalizeJson } from "./canonical-json";
import type {
  WorkspaceMutationCoordinator,
  WorkspaceProjectCreateRequest,
  WorkspaceProjectDeleteRequest,
  WorkspaceProjectRenameRequest,
  WorkspaceProjectLocation,
  WorkspaceWriteRequest,
} from "./workspace-mutation-coordinator";

export type SingleSourceMutationRequest =
  | {
      kind: "file";
      ref: ProjectRef;
      path: RelPath;
      content: string | Uint8Array;
      expectedContentHash: string | null;
    }
  | {
      kind: "entity";
      ref: ProjectRef;
      entity: "preview-settings";
      patch: PreviewSettingsPatchDto;
      expectedRevision: number;
    };

/** Compile-time closed set of paths owned by derived project state and artifacts. */
export type DerivedMutationPath = RelPath & (
  | `.vidcom/${string}`
  | `snapshots/${string}`
  | `renders/${string}`
);

export interface DerivedMutationRequest {
  ref: ProjectRef;
  writes: Array<{ path: DerivedMutationPath; content: string | Uint8Array | StagedFileSource }>;
  producedByJobId: JobId | null;
  computedAtSourceRevision: number;
}

/** Backward-compatible name for source-only callers; no caller-selectable purpose remains. */
export type SourceMutationRequest = SingleSourceMutationRequest | CompositeRequest;
export type MutationRequest = SingleSourceMutationRequest;

/** Successful mutation payload returned to transport adapters. */
export interface WriteResult {
  path: RelPath | null;
  contentHash: ContentHash;
  revision: number;
  diagnostics: Diagnostic[];
  /** Exact durable outbox sequence when this result was projected from a composite write. */
  changeSeq?: number | null;
  previewSettings?: PreviewSettingsDto;
}

/** Injected dependencies that keep Core free of filesystem, crypto and adapter imports. */
export interface WriteAuthorityDependencies {
  workspace: WorkspacePort;
  journal: MutationJournalPort;
  compositeJournal: CompositeMutationJournalPort;
  lease: LeasePort;
  leaseId: string;
  hashContent(content: string | Uint8Array): ContentHash;
  validateFileContent?(path: RelPath, content: string | Uint8Array): Promise<Result<void, DomainError>>;
  invalidate(projectId: ProjectId): void;
  pathInvalidator?: ProjectPathInvalidator;
  recordWrittenHash?(projectId: ProjectId, path: RelPath, hash: ContentHash): void;
  writtenStates?: WrittenStateTrackerPort;
  pendingMount?: PendingMountPort;
  notifyEvents(): void;
  stagedAssets?: StagedAssetPort;
  backups?: BackupPort;
  reconcileJournal?(id: JournalId): Promise<Result<CompositeReconcileOutcome, DomainError>>;
  workspaceCoordinator?: WorkspaceMutationCoordinator;
  /** P0 seam; task 0.9 supplies the named no-op and production composition wiring. */
  observer?: MutationObserverPort;
  /** Live history content store; omitted until the P0 production wiring task. */
  undoContent?: UndoContentPort;
  clock?: ClockPort;
}

/** Journal-first identity write prepared by `bootstrapProject`. */
export interface BootstrapIdentityWrite {
  ref: ProjectRef;
  journalId: JournalId;
  content: string;
  previousContent: string | null;
  fromHash: ContentHash | null;
  toHash: ContentHash;
  actor?: Actor;
}

export interface AdoptProjectIdentityRequest {
  ref: ProjectRef;
  workspaceRoot: string;
  content: string;
  occurredAt: string;
  actor?: Actor;
  /** Omitted for candidate adoption; required when replacing an invalid recovery marker. */
  expectedContentHash?: ContentHash;
  /** Present only for an MCP-invoked adoption, which the bootstrap journal then owns. */
  toolAudit?: PendingToolAudit | null;
}

class ProjectMutex {
  private readonly tails = new Map<ProjectId, Promise<void>>();

  async run<Value>(projectId: ProjectId, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(projectId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    }
  }
}

function pathError(rejection: PathRejection): DomainError {
  switch (rejection.reason) {
    case "invalid_syntax":
      return { code: ErrorCode.PathInvalid, message: "path is not a valid project-relative path" };
    case "outside_project":
    case "symlink_escape":
      return { code: ErrorCode.PathOutsideProject, message: "path resolves outside the project" };
    case "not_allowed_for_purpose":
      return {
        code: ErrorCode.AssetNotAllowed,
        message: "the path is not allowed for this mutation method",
        details: { reason: rejection.reason },
      };
  }
}

function validateExpectedHash(value: string | null): DomainError | null {
  if (value === null || /^sha256:[0-9a-f]{64}$/.test(value)) return null;
  if (/^[0-9a-z]+-[0-9a-z]+$/.test(value)) {
    return {
      code: ErrorCode.VersionFormatLegacy,
      message: "the client uses a legacy version format and must be upgraded",
      field: "expectedContentHash",
    };
  }
  return {
    code: ErrorCode.SchemaInvalid,
    message: "expectedContentHash must be a sha256 content hash",
    field: "expectedContentHash",
  };
}

function conflict(details: Record<string, unknown>, field: string): DomainError {
  return {
    code: ErrorCode.WriteConflict,
    message: "the project changed since it was read",
    field,
    details,
  };
}

function isPathBelow(path: RelPath, ancestor: RelPath): boolean {
  return path.startsWith(`${ancestor}/`);
}

function validateDirectoryOrder(steps: readonly CompositeStep[]): DomainError | null {
  for (const [index, step] of steps.entries()) {
    if (step.kind === "mkdir") {
      const lateParent = steps.findIndex((candidate, candidateIndex) =>
        candidateIndex > index && candidate.kind === "mkdir" && isPathBelow(step.path, candidate.path));
      if (lateParent !== -1) {
        return { code: ErrorCode.SchemaInvalid, message: "mkdir steps must be ordered shallow-first", field: "steps" };
      }
    }
    if (step.kind === "rmdir") {
      const lateChildRemoval = steps.findIndex((candidate, candidateIndex) =>
        candidateIndex > index
        && (candidate.kind === "delete" || candidate.kind === "rmdir")
        && isPathBelow(candidate.path, step.path));
      if (lateChildRemoval !== -1) {
        return { code: ErrorCode.SchemaInvalid, message: "rmdir must follow every child removal", field: "steps" };
      }
    }
  }
  return null;
}

function validContentHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function samePendingOpen(record: PendingMountOpen, expected: PendingMountOpen): boolean {
  return canonicalizeJson(record) === canonicalizeJson(expected);
}

interface PreparedCompositeStep {
  step: CompositeStep;
  target: ResolvedPath;
  lease: MutationPathLease;
  entityState: EntityState | null;
}

interface PreparedHistoryReadGuard {
  guard: MutationReadGuard;
  target: ResolvedPath;
}

interface RetainedCompositeStep {
  ordinal: number;
  beforeContent: UndoContentRef | null;
  afterContent: UndoContentRef | null;
}

interface RetainedCompositeContent {
  steps: RetainedCompositeStep[];
  refs: UndoContentRef[];
}

interface ValidatedCompositeStep extends PreparedCompositeStep {
  intent: StepIntent;
  content: string | Uint8Array | StagedFileSource | null;
  previewSettings: PreviewSettingsDto | null;
  previousPreviewSettings: PreviewSettingsDto | null;
  generatedReadGuard?: MutationReadGuard;
}

function isStagedFileSource(value: unknown): value is StagedFileSource {
  return !!value && typeof value === "object"
    && typeof (value as Partial<StagedFileSource>).sourcePath === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(String((value as Partial<StagedFileSource>).contentHash));
}

const SOURCE_ASSET_PREFIXES = ["assets/", "preview-assets/", "narration/"] as const;
const DERIVED_ASSET_PREFIXES = ["snapshots/", "renders/"] as const;
const MAX_INLINE_CONTENT_BYTES = 64 * 1024;
const MAX_INLINE_RECEIPT_BYTES = 256 * 1024;

export type MutationMethod = "source" | "derived" | "workspace";

/** Closed `(method, path)` authority table; a miss never falls through to another method. */
export function inferMutationPurpose(method: MutationMethod, path: RelPath): PathPurpose | null {
  if (method === "workspace") {
    return checkPathPurpose(path, "workspace-agent-kit") === null ? "workspace-agent-kit" : null;
  }
  if (method === "derived") {
    if (path.startsWith(".vidcom/")) return "state-write";
    return DERIVED_ASSET_PREFIXES.some((root) => path.startsWith(root)) ? "write-asset" : null;
  }
  if (path.startsWith(".vidcom/") || DERIVED_ASSET_PREFIXES.some((root) => path.startsWith(root))) {
    return null;
  }
  if (path === "vidcom.json" || path === "preview-settings.json"
    || (path.startsWith("narration/") && path.endsWith(".json"))) {
    return "system-write";
  }
  return SOURCE_ASSET_PREFIXES.some((root) => path.startsWith(root)) ? "write-asset" : "write-source";
}

/** Single project write authority enforcing lease, mutex, precondition, journal and event order. */
export class WriteAuthority {
  private readonly mutex = new ProjectMutex();

  constructor(private readonly dependencies: WriteAuthorityDependencies) {}

  /** Executes one ordered multi-target mutation only while the lease and project recovery gate permit writes. */
  private async executeComposite(
    request: CompositeRequest,
    actor: Actor,
    advancesSource: boolean,
  ): Promise<Result<WriteEnvelope, DomainError>> {
    const directoryOrderError = validateDirectoryOrder(request.steps);
    if (directoryOrderError) return err(directoryOrderError);
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    return this.mutex.run(request.ref.id, async () => {
      if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
        return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
      }
      try {
        await this.dependencies.compositeJournal.assertProjectWritable(request.ref.id);
      } catch {
        const recovery = await this.dependencies.compositeJournal.readProjectRecoveryStatus(request.ref.id);
        return err({
          code: ErrorCode.RecoveryRequired,
          message: "the project has unresolved mutations",
          details: { recovery },
        });
      }
      const prepared = await this.resolveCompositeTargets(request, advancesSource);
      if (!prepared.ok) return prepared;
      const readGuards = await this.resolveHistoryReadGuards(request, prepared.value, advancesSource);
      if (!readGuards.ok) return readGuards;
      const validated = await this.validateCompositePreconditions(
        request,
        prepared.value,
        readGuards.value,
        advancesSource,
      );
      if (!validated.ok) {
        const blockedBy = this.blockInverseHistoryOnPreconditionConflict(
          request,
          prepared.value,
          readGuards.value,
          validated.error,
        );
        return blockedBy === null
          ? validated
          : err({
              ...validated.error,
              details: { ...validated.error.details, blockedBy },
            });
      }
      const pending = await this.validatePendingMountTransition(request, validated.value);
      if (!pending.ok) return pending;
      return this.executeValidatedComposite(request, validated.value, actor, advancesSource);
    });
  }

  private blockInverseHistoryOnPreconditionConflict(
    request: CompositeRequest,
    prepared: PreparedCompositeStep[],
    readGuards: PreparedHistoryReadGuard[],
    error: DomainError,
  ): RelPath[] | null {
    if ((request.origin.historyAction !== "undo" && request.origin.historyAction !== "redo")
      || error.code !== ErrorCode.WriteConflict) return null;
    const preconditionFields = new Set([
      "expectedRevision",
      "expectExisting",
      "expectEmpty",
      "path",
      "expectedContentHash",
      "historyReadGuards",
    ]);
    if (!error.field || !preconditionFields.has(error.field)) return null;

    const candidates = error.field === "historyReadGuards"
      ? readGuards.map(({ guard }) => guard.path)
      : prepared.map(({ step, entityState }) => step.kind === "entity" ? entityState!.backingPath : step.path);
    const reportedPath = typeof error.details?.path === "string"
      ? candidates.find((path) => path === error.details?.path)
      : undefined;
    const paths = reportedPath === undefined ? candidates : [reportedPath];
    try {
      this.dependencies.observer?.blockHistoryOperation(request.ref.id, request.origin, paths);
    } catch {}
    return paths;
  }

  private async resolveCompositeTargets(
    request: CompositeRequest,
    advancesSource: boolean,
  ): Promise<Result<PreparedCompositeStep[], DomainError>> {
    const prepared: PreparedCompositeStep[] = [];
    const canonicalTargets = new Set<ResolvedPath>();
    for (const step of request.steps) {
      let path: RelPath;
      let purpose: PathPurpose;
      let entityState: EntityState | null = null;
      if (step.kind === "entity") {
        entityState = await this.dependencies.journal.readEntityState(request.ref.id, step.entity);
        if (!entityState) return err({ code: ErrorCode.Internal, message: "entity state has not been initialized" });
        path = entityState.backingPath;
        purpose = "system-write";
      } else {
        path = step.path;
        if (step.kind === "write-staged" && !advancesSource) {
          return err({ code: ErrorCode.SchemaInvalid, message: "write-staged is only available to authored mutations" });
        }
        const inferred = step.kind === "mkdir" || step.kind === "rmdir" || step.kind === "write-staged"
          ? advancesSource ? "authored-write" : null
          : inferMutationPurpose(advancesSource ? "source" : "derived", step.path);
        if (inferred === null) {
          return err(pathError({ reason: "not_allowed_for_purpose" }));
        }
        purpose = inferred;
      }
      const resolved = await this.dependencies.workspace.resolveMutation(request.ref, path, purpose);
      if (!resolved.ok) return err(pathError(resolved.error));
      if (canonicalTargets.has(resolved.value.target)) {
        return err({
          code: ErrorCode.DuplicateMutationTarget,
          message: "multiple mutation steps resolve to the same project target",
          details: { path },
        });
      }
      canonicalTargets.add(resolved.value.target);
      prepared.push({ step, target: resolved.value.target, lease: resolved.value, entityState });
    }
    return ok(prepared);
  }

  private async resolveHistoryReadGuards(
    request: CompositeRequest,
    steps: PreparedCompositeStep[],
    advancesSource: boolean,
  ): Promise<Result<PreparedHistoryReadGuard[], DomainError>> {
    const mutationTargets = new Set(steps.map(({ target }) => target));
    const byTarget = new Map<ResolvedPath, PreparedHistoryReadGuard>();
    for (const guard of request.historyReadGuards ?? []) {
      // Read guards are Core-owned dependencies, not transport-selected reads. Authored
      // package guards must support the same binary extensions as their staged writes.
      const purpose = advancesSource
        ? "read-package-target"
        : inferMutationPurpose("derived", guard.path);
      if (purpose === null) return err(pathError({ reason: "not_allowed_for_purpose" }));
      if (guard.state.kind === "file" && !/^sha256:[0-9a-f]{64}$/u.test(guard.state.contentHash)) {
        return err({
          code: ErrorCode.SchemaInvalid,
          message: "history read guard contentHash must be a sha256 content hash",
          field: "historyReadGuards",
        });
      }
      const resolved = await this.dependencies.workspace.resolve(request.ref, guard.path, purpose);
      if (!resolved.ok) return err(pathError(resolved.error));
      if (mutationTargets.has(resolved.value)) {
        return err({
          code: ErrorCode.SchemaInvalid,
          message: "a history read guard cannot also be a mutation target",
          field: "historyReadGuards",
        });
      }
      const previous = byTarget.get(resolved.value);
      if (previous) {
        if (canonicalizeJson(previous.guard.state) !== canonicalizeJson(guard.state)) {
          return err({
            code: ErrorCode.SchemaInvalid,
            message: "history read guards disagree for one canonical path",
            field: "historyReadGuards",
          });
        }
        continue;
      }
      byTarget.set(resolved.value, { guard, target: resolved.value });
    }
    return ok([...byTarget.values()]);
  }

  private async validateCompositePreconditions(
    request: CompositeRequest,
    prepared: PreparedCompositeStep[],
    readGuards: PreparedHistoryReadGuard[],
    advancesSource: boolean,
  ): Promise<Result<ValidatedCompositeStep[], DomainError>> {
    const validated: ValidatedCompositeStep[] = [];
    const observedHashes: Record<RelPath, ContentHash> = {};
    for (const [ordinal, item] of prepared.entries()) {
      const { step } = item;
      if (step.kind === "entity") {
        const state = item.entityState;
        if (!state) return err({ code: ErrorCode.Internal, message: "entity state was lost during planning" });
        const current = await this.dependencies.workspace.readFile(item.target);
        const defaultContent = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
        const physicalHash = current?.contentHash ?? this.dependencies.hashContent(defaultContent);
        let raw: unknown = DEFAULT_PREVIEW_SETTINGS;
        if (current) {
          try { raw = JSON.parse(current.content); } catch { raw = DEFAULT_PREVIEW_SETTINGS; }
        }
        const currentSettings = normalizePreviewSettings(raw);
        const expectedHashInvalid = step.expectedContentHash !== undefined
          && !/^sha256:[0-9a-f]{64}$/u.test(step.expectedContentHash);
        if (expectedHashInvalid) {
          return err({
            code: ErrorCode.SchemaInvalid,
            message: "entity expectedContentHash must be a sha256 content hash",
            field: "expectedContentHash",
          });
        }
        if (step.expectedRevision !== state.revision || physicalHash !== state.contentHash
          || (step.expectedContentHash !== undefined && physicalHash !== step.expectedContentHash)) {
          return err(conflict({
            current: { previewSettings: currentSettings, contentHash: physicalHash, revision: state.revision },
          }, step.expectedContentHash !== undefined && physicalHash !== step.expectedContentHash
            ? "expectedContentHash"
            : "expectedRevision"));
        }
        const previewSettings = mergePreviewSettings(currentSettings, step.patch);
        const content = serializePreviewSettings(previewSettings);
        const toHash = this.dependencies.hashContent(content);
        observedHashes[state.backingPath] = physicalHash;
        validated.push({
          ...item,
          content,
          previewSettings,
          previousPreviewSettings: currentSettings,
          intent: {
            ordinal,
            kind: "entity",
            path: null,
            entity: step.entity,
            fromHash: physicalHash,
            toHash,
            previousContent: current?.content ?? null,
          },
        });
        continue;
      }

      if (step.kind === "mkdir" || step.kind === "rmdir") {
        const current = await this.dependencies.workspace.stat(item.target);
        if (step.kind === "mkdir") {
          if (current !== null && current.kind !== "directory") {
            return err(conflict({ path: step.path, currentState: current.kind }, "expectExisting"));
          }
          if (step.expectExisting === "absent" && current !== null) {
            return err(conflict({ path: step.path, currentState: "directory" }, "expectExisting"));
          }
          const existedBefore = current?.kind === "directory";
          validated.push({
            ...item,
            content: null,
            previewSettings: null,
            previousPreviewSettings: null,
            ...(existedBefore && step.expectExisting === "either"
              ? { generatedReadGuard: { path: step.path, state: { kind: "directory" } } }
              : {}),
            intent: {
              ordinal,
              kind: "mkdir",
              path: step.path,
              entity: null,
              fromHash: null,
              toHash: null,
              previousContent: null,
              existedBefore,
            },
          });
          continue;
        }
        if (current?.kind !== "directory") {
          return err(conflict({ path: step.path, currentState: current?.kind ?? "absent" }, "expectEmpty"));
        }
        const entries = await this.dependencies.workspace.readDirectory(item.target);
        if (entries === null) {
          return err(conflict({ path: step.path, currentState: "absent" }, "expectEmpty"));
        }
        const plannedPrior = new Map(
          prepared.slice(0, ordinal).flatMap(({ step: planned }) =>
            planned.kind === "delete" || planned.kind === "rmdir"
              ? [[planned.path, planned.kind] as const]
              : []),
        );
        const unplanned = entries.find((entry) => {
          const child = `${step.path}/${entry.name}` as RelPath;
          const plannedKind = plannedPrior.get(child);
          return entry.kind === "directory"
            ? plannedKind !== "rmdir"
            : entry.kind !== "file" || plannedKind !== "delete";
        });
        if (unplanned) {
          return err(conflict({ path: step.path, blockedBy: unplanned.name }, "expectEmpty"));
        }
        validated.push({
          ...item,
          content: null,
          previewSettings: null,
          previousPreviewSettings: null,
          intent: {
            ordinal,
            kind: "rmdir",
            path: step.path,
            entity: null,
            fromHash: null,
            toHash: null,
            previousContent: null,
            existedBefore: true,
          },
        });
        continue;
      }

      const formatError = validateExpectedHash(step.expectedContentHash);
      if (formatError) return err(formatError);
      if (step.kind === "write" && advancesSource && isStagedFileSource(step.content)) {
        return err({ code: ErrorCode.SchemaInvalid, message: "authored writes cannot use a staged file source" });
      }
      if (step.kind === "write-staged") {
        if (!advancesSource || !isStagedFileSource(step.source)) {
          return err({ code: ErrorCode.SchemaInvalid, message: "write-staged requires an opaque staged file source" });
        }
        if (!step.undoable && step.expectedContentHash !== null) {
          return err({
            code: ErrorCode.SchemaInvalid,
            message: "a non-undoable staged upload can only create a new target",
            field: "expectedContentHash",
          });
        }
        const separator = step.path.lastIndexOf("/");
        if (separator > 0) {
          const parentPath = step.path.slice(0, separator) as RelPath;
          const plannedParent = prepared.slice(0, ordinal).some(
            ({ step: candidate }) => candidate.kind === "mkdir" && candidate.path === parentPath,
          );
          if (!plannedParent) {
            const parent = await this.dependencies.workspace.resolveMutation(request.ref, parentPath, "authored-write");
            if (!parent.ok || (await this.dependencies.workspace.stat(parent.value.target))?.kind !== "directory") {
              return err(conflict({ path: step.path, parent: parentPath }, "path"));
            }
          }
        }
      }
      const streamedPrecondition = step.kind === "write-staged" || step.kind === "delete";
      const current = streamedPrecondition ? null : await this.dependencies.workspace.readBytes(item.target);
      const currentHash = streamedPrecondition
        ? await this.dependencies.workspace.readHash(item.target)
        : current?.contentHash ?? null;
      if ((step.kind === "write" || step.kind === "write-staged")
        && currentHash !== null && step.expectedContentHash === null) {
        return err({
          code: ErrorCode.PreconditionRequired,
          message: "expectedContentHash is required for an existing file",
          field: "expectedContentHash",
        });
      }
      if (currentHash !== step.expectedContentHash) {
        const currentFile = streamedPrecondition ? null : await this.dependencies.workspace.readFile(item.target);
        return err(conflict({
          path: step.path,
          current: currentFile
            ? {
                content: currentFile.content,
                contentHash: currentFile.contentHash,
                revision: (await this.dependencies.journal.latestRevision(request.ref.id)) ?? 0,
              }
            : currentHash === null ? null : {
                contentHash: currentHash,
                revision: (await this.dependencies.journal.latestRevision(request.ref.id)) ?? 0,
              },
        }, "expectedContentHash"));
      }
      if (step.kind === "delete" && currentHash === null) {
        return err({ code: ErrorCode.NotFound, message: "the deletion target was not found" });
      }
      if (currentHash !== null) observedHashes[step.path] = currentHash;
      validated.push({
        ...item,
        content: step.kind === "write"
          ? step.content
          : step.kind === "write-staged" ? step.source : null,
        previewSettings: null,
        previousPreviewSettings: null,
        intent: step.kind === "write" || step.kind === "write-staged"
          ? {
              ordinal,
              kind: "write",
              path: step.path,
              entity: null,
              fromHash: currentHash,
              toHash: step.kind === "write-staged"
                ? step.source.contentHash
                : isStagedFileSource(step.content)
                  ? step.content.contentHash
                  : this.dependencies.hashContent(step.content),
              previousContent: streamedPrecondition ? null : current?.bytes ?? null,
            }
          : {
              ordinal,
              kind: "delete",
              path: step.path,
              entity: null,
              fromHash: currentHash,
              toHash: null,
              previousContent: streamedPrecondition ? null : current?.bytes ?? null,
            },
      });
    }

    for (const { guard, target } of readGuards) {
      const current = await this.dependencies.workspace.stat(target);
      if (guard.state.kind === "directory") {
        if (current?.kind !== "directory") {
          return err(conflict({ path: guard.path, expectedState: "directory" }, "historyReadGuards"));
        }
        continue;
      }
      const currentHash = current?.kind === "file"
        ? await this.dependencies.workspace.readHash(target)
        : null;
      if (currentHash !== guard.state.contentHash) {
        return err(conflict({
          path: guard.path,
          expectedContentHash: guard.state.contentHash,
          currentHash,
        }, "historyReadGuards"));
      }
      observedHashes[guard.path] = currentHash;
    }

    if (request.grant) {
      const latestRevision = (await this.dependencies.journal.latestRevision(request.ref.id)) ?? 0;
      const binding = request.grant.binding;
      if (binding.projectId !== request.ref.id
        || binding.expectedRevision !== latestRevision
        || canonicalizeJson(binding.targetHashes) !== canonicalizeJson(observedHashes)) {
        return err({
          code: binding.expectedRevision !== latestRevision ? ErrorCode.WriteConflict : ErrorCode.ApprovalInvalid,
          message: "the approved mutation plan no longer matches current project state",
        });
      }
    }
    return ok(validated);
  }

  private async validatePendingMountTransition(
    request: CompositeRequest,
    steps: ValidatedCompositeStep[],
  ): Promise<Result<void, DomainError>> {
    const transition = request.pendingMountTransition;
    if (!transition) return ok(undefined);
    if (!PendingMountOperationIdSchema.safeParse(transition.operationId).success) {
      return err({ code: ErrorCode.SchemaInvalid, message: "pending mount operationId must be a ULID", field: "operationId" });
    }
    const pending = this.dependencies.pendingMount;
    if (!pending) {
      return err({ code: ErrorCode.StorageUnavailable, message: "pending mount storage is unavailable" });
    }
    let lookup: Awaited<ReturnType<PendingMountPort["lookup"]>>;
    try { lookup = await pending.lookup(request.ref.id, transition.operationId); }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "pending mount state could not be read" }); }

    if (transition.kind === "open") {
      const record = transition.record;
      if (record.operationId !== transition.operationId
        || record.projectId !== request.ref.id
        || !validContentHash(record.assetContentHash)
        || !validContentHash(record.uploadFingerprint)
        || !Number.isFinite(record.atSeconds) || record.atSeconds < 0
        || !Number.isSafeInteger(record.trackIndex) || record.trackIndex < 0) {
        return err({ code: ErrorCode.SchemaInvalid, message: "pending mount open record is invalid", field: "pendingMountTransition" });
      }
      const write = steps.find(({ step }) => step.kind === "write-staged"
        && step.path === record.assetPath
        && step.source.contentHash === record.assetContentHash);
      if (!write) {
        return err({ code: ErrorCode.SchemaInvalid, message: "pending mount open must match one write-staged step" });
      }
      if (lookup.state === "expired") return err({ code: ErrorCode.NotFound, message: "pending mount operation has expired" });
      if (lookup.state === "active" && !samePendingOpen({
        operationId: lookup.record.operationId,
        projectId: lookup.record.projectId,
        assetPath: lookup.record.assetPath,
        assetContentHash: lookup.record.assetContentHash,
        uploadFingerprint: lookup.record.uploadFingerprint,
        atSeconds: lookup.record.atSeconds,
        trackIndex: lookup.record.trackIndex,
      }, record)) {
        return err({ code: ErrorCode.WriteConflict, message: "pending mount operation was already used with different input" });
      }
      return ok(undefined);
    }

    if (lookup.state !== "active") {
      return err({ code: ErrorCode.NotFound, message: "pending mount operation was not found" });
    }
    if (transition.kind === "close") {
      if (lookup.record.state !== "uploaded_unmounted"
        || canonicalizeJson(lookup.record.lastFailure) !== canonicalizeJson(transition.previousFailure)
        || transition.sceneId.length === 0) {
        return err({ code: ErrorCode.WriteConflict, message: "pending mount close precondition changed" });
      }
      return ok(undefined);
    }
    if (request.origin.historyAction !== "undo"
      || lookup.record.state !== "mounted"
      || lookup.record.mountedSceneId !== transition.expectedSceneId) {
      return err({ code: ErrorCode.WriteConflict, message: "pending mount reopen precondition changed" });
    }
    return ok(undefined);
  }

  private async retainCompositeContent(
    steps: ValidatedCompositeStep[],
    captures: MutationCapture[],
    retainsHistory: boolean,
  ): Promise<Result<RetainedCompositeContent, DomainError>> {
    const store = this.dependencies.undoContent;
    if (!store || !retainsHistory) return ok({ steps: [], refs: [] });
    const retained: RetainedCompositeContent = { steps: [], refs: [] };
    let inlineBytes = 0;
    const retainBytes = async (bytes: Uint8Array, encoding: "utf8" | "binary") => {
      const inline = bytes.byteLength <= MAX_INLINE_CONTENT_BYTES
        && inlineBytes + bytes.byteLength <= MAX_INLINE_RECEIPT_BYTES;
      const ref = await store.retainBytes(bytes, encoding, inline ? "inline" : "object");
      if (inline) inlineBytes += bytes.byteLength;
      retained.refs.push(ref);
      return ref;
    };
    try {
      for (const item of steps) {
        if (item.step.kind === "entity" || item.step.kind === "mkdir" || item.step.kind === "rmdir") continue;
        if (item.step.kind === "write-staged" && !item.step.undoable) continue;
        const capture = captures[item.intent.ordinal];
        let beforeContent: UndoContentRef | null = null;
        if (item.intent.fromHash !== null && capture?.rollbackPath) {
          const previous = item.intent.previousContent;
          if (previous === null) {
            beforeContent = await store.retainFile({
              sourcePath: capture.rollbackPath as unknown as AbsolutePath,
              contentHash: item.intent.fromHash,
            }, "binary");
            retained.refs.push(beforeContent);
          } else {
          const size = previous instanceof Uint8Array
            ? previous.byteLength
            : typeof previous === "string" ? new TextEncoder().encode(previous).byteLength : 0;
          if (size > MAX_INLINE_CONTENT_BYTES) {
            beforeContent = await store.retainFile({
              sourcePath: capture.rollbackPath as unknown as AbsolutePath,
              contentHash: item.intent.fromHash,
            }, previous instanceof Uint8Array ? "binary" : "utf8");
            retained.refs.push(beforeContent);
          } else if (previous !== null) {
            const bytes = previous instanceof Uint8Array ? previous : new TextEncoder().encode(previous);
            beforeContent = await retainBytes(bytes, previous instanceof Uint8Array ? "binary" : "utf8");
          }
          }
        }
        let afterContent: UndoContentRef | null = null;
        if (item.step.kind === "write" || item.step.kind === "write-staged") {
          if (isStagedFileSource(item.content)) {
            afterContent = await store.retainFile(item.content, "binary");
            retained.refs.push(afterContent);
          } else {
            const bytes = item.content instanceof Uint8Array
              ? item.content
              : new TextEncoder().encode(item.content ?? "");
            afterContent = await retainBytes(bytes, item.content instanceof Uint8Array ? "binary" : "utf8");
          }
        }
        retained.steps.push({ ordinal: item.intent.ordinal, beforeContent, afterContent });
      }
      return ok(retained);
    } catch {
      store.release(retained.refs);
      return err({ code: ErrorCode.StorageUnavailable, message: "history content could not be retained" });
    }
  }

  private deliverReceipt(
    request: CompositeRequest,
    journalId: JournalId,
    steps: ValidatedCompositeStep[],
    retained: RetainedCompositeContent,
    envelope: WriteEnvelope,
    historyEnabled: boolean,
  ): WriteEnvelope {
    const observer = this.dependencies.observer;
    const clock = this.dependencies.clock;
    if (!observer || !clock) {
      this.dependencies.undoContent?.release(retained.refs);
      return envelope;
    }
    const retainedByOrdinal = new Map(retained.steps.map((item) => [item.ordinal, item]));
    const receiptSteps: MutationReceiptStep[] = steps.map((item) => {
      if (item.step.kind === "entity") {
        const state = item.entityState!;
        return {
          kind: "entity",
          undoable: historyEnabled && (item.step.undoable ?? false),
          entity: item.step.entity,
          backingPath: state.backingPath,
          beforeState: item.previousPreviewSettings,
          afterState: item.previewSettings!,
          fromRevision: state.revision,
          toRevision: envelope.entityRevision ?? state.revision + 1,
          fromHash: item.intent.fromHash,
          toHash: item.intent.toHash!,
        };
      }
      if (item.step.kind === "mkdir" || item.step.kind === "rmdir") {
        return {
          kind: "directory",
          undoable: historyEnabled,
          op: item.step.kind,
          path: item.step.path,
          existedBefore: item.intent.kind === "mkdir" || item.intent.kind === "rmdir"
            ? item.intent.existedBefore
            : false,
        };
      }
      const content = retainedByOrdinal.get(item.intent.ordinal);
      if (!historyEnabled || !content) {
        return {
          kind: "file",
          undoable: false,
          path: item.step.path,
          fromHash: item.intent.fromHash,
          toHash: item.intent.toHash,
          omittedReason: "not-undoable",
        };
      }
      return {
        kind: "file",
        undoable: true,
        path: item.step.path,
        beforeContent: content.beforeContent,
        afterContent: content.afterContent,
        fromHash: item.intent.fromHash,
        toHash: item.intent.toHash,
      };
    });
    if (historyEnabled && request.pendingMountTransition?.kind === "close") {
      receiptSteps.push({
        kind: "pending-mount",
        undoable: true,
        operationId: request.pendingMountTransition.operationId,
        before: {
          state: "uploaded_unmounted",
          lastFailure: request.pendingMountTransition.previousFailure,
        },
        after: {
          state: "mounted",
          sceneId: request.pendingMountTransition.sceneId,
          revision: envelope.projectRevision,
        },
      });
    }
    const paths = steps.map((item) => item.step.kind === "entity"
      ? item.entityState!.backingPath
      : item.step.path);
    const receipt: MutationReceipt = {
      id: `journal:${journalId}`,
      projectId: request.ref.id,
      origin: request.origin,
      steps: receiptSteps,
      paths,
      readGuards: [
        ...(request.historyReadGuards ?? []),
        ...steps.flatMap((item) => item.generatedReadGuard ? [item.generatedReadGuard] : []),
      ],
      projectRevision: envelope.projectRevision,
      at: clock.now().toISOString(),
      undoable: receiptSteps.every((step) => step.undoable),
    };
    let emitted: { ok: true } | { ok: false; reason: string };
    try {
      emitted = observer.emit(receipt);
    } catch {
      emitted = { ok: false, reason: "history observer threw" };
    }
    const completedEnvelope = request.origin.historyAction === "undo" || request.origin.historyAction === "redo"
      ? { ...envelope, inverseReceipt: receipt }
      : envelope;
    if (emitted.ok) return completedEnvelope;
    this.dependencies.undoContent?.release(retained.refs);
    observer.invalidateProject(request.ref.id, "history-desync");
    return {
      ...completedEnvelope,
      diagnostics: [...envelope.diagnostics, {
        severity: "warning",
        code: "history-unavailable",
        message: emitted.reason,
      }],
    };
  }

  private async executeValidatedComposite(
    request: CompositeRequest,
    steps: ValidatedCompositeStep[],
    actor: Actor,
    advancesSource: boolean,
  ): Promise<Result<WriteEnvelope, DomainError>> {
    if (steps.every((item) => item.intent.kind === "mkdir"
      ? item.intent.existedBefore
      : item.intent.kind !== "delete" && item.intent.kind !== "rmdir"
        && item.intent.fromHash === item.intent.toHash)) {
      // Nothing to write: the project already holds exactly this content. No
      // journal opens, so the caller has to be told — an MCP tool cannot own its
      // audit through a journal that never existed.
      request.noteUnchanged?.();
      const projectRevision = (await this.dependencies.journal.latestRevision(request.ref.id)) ?? 0;
      const fileHashes: Record<RelPath, ContentHash> = {};
      let entityRevision: number | null = null;
      for (const item of steps) {
        if (item.intent.kind === "entity") {
          const backingPath = item.entityState?.backingPath;
          if (backingPath) fileHashes[backingPath] = item.intent.toHash;
          entityRevision = item.entityState?.revision ?? null;
        } else if (item.intent.kind === "write") {
          fileHashes[item.intent.path] = item.intent.toHash;
        }
      }
      return ok({ projectRevision, entityRevision, fileHashes, diagnostics: request.diagnostics ?? [], changeSeq: null });
    }
    const grantReserve = request.grant
      ? { kind: "reserve" as const, grantId: request.grant.id, binding: request.grant.binding }
      : undefined;
    let journalId: JournalId;
    let backupId: string | null = null;
    const captures: MutationCapture[] = [];
    try {
      journalId = await this.dependencies.compositeJournal.beginComposite(
        { projectId: request.ref.id, actor },
        steps.map(({ intent }) => intent),
        { toolAudit: request.toolAudit, ...(request.commandAudit ? { commandAudit: request.commandAudit } : {}) },
        { leaseId: this.dependencies.leaseId },
        grantReserve,
        request.pendingMountTransition,
      );
    } catch (error) {
      return err(this.compositeStorageError(error, "composite mutation could not begin"));
    }

    for (const item of steps) {
      try {
        const itemPath = item.step.kind === "write" || item.step.kind === "write-staged" || item.step.kind === "delete"
          ? item.step.path
          : null;
        const captured = await this.dependencies.workspace.captureForMutation(
          item.target,
          item.intent.kind === "mkdir" || item.intent.kind === "rmdir"
            ? { kind: "directory", existedBefore: item.intent.existedBefore }
            : item.step.kind === "write-staged" || item.step.kind === "delete"
              ? item.intent.fromHash
              : item.intent.previousContent === null ? null : item.intent.fromHash,
          journalId,
          item.intent.ordinal,
          itemPath
            ? {
              rollbackOutside: steps.flatMap((candidate) =>
                  candidate.step.kind === "rmdir" && isPathBelow(itemPath, candidate.step.path)
                    ? [candidate.target]
                    : []),
                lease: item.lease,
              }
            : { lease: item.lease },
        );
        if (!captured.ok) {
          if ("reason" in captured.error && captured.error.reason === "recovery_required") {
            captures.push(captured.error.capture);
            try {
              await this.dependencies.compositeJournal.markStepCaptured(
                journalId,
                item.intent.ordinal,
                captured.error.capture.rollbackPath,
                captured.error.capture.capturedHash,
              );
            } catch {
              // The deterministic rollback path still embeds journal + ordinal;
              // orphaning T1 below keeps recovery ownership even if this update failed.
            }
            return this.orphanCapturedMutation(request, journalId, captures, "capture_restore_blocked");
          }
          const restored = await this.restoreCapturedSteps(steps, captures, new Set());
          if (!restored) {
            return this.orphanCapturedMutation(request, journalId, captures, "capture_conflict");
          }
          await this.dependencies.compositeJournal.abortComposite(
            journalId,
            ErrorCode.WriteConflict,
            request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
          );
          await this.discardCaptures(captures);
          return err(conflict(
            "actualHash" in captured.error
              ? { currentHash: captured.error.actualHash }
              : { currentState: captured.error.actualState },
            "expectedContentHash",
          ));
        }
        captures.push(captured.value);
        await this.dependencies.compositeJournal.markStepCaptured(
          journalId,
          item.intent.ordinal,
          captured.value.rollbackPath,
          captured.value.capturedHash,
        );
      } catch {
        const restored = await this.restoreCapturedSteps(steps, captures, new Set());
        if (!restored) return this.orphanCapturedMutation(request, journalId, captures, "capture");
        try {
          await this.dependencies.compositeJournal.abortComposite(
            journalId,
            ErrorCode.StorageUnavailable,
            request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
          );
          await this.discardCaptures(captures);
          return err({ code: ErrorCode.StorageUnavailable, message: "the mutation target could not be captured safely" });
        } catch {
          return err({
            code: ErrorCode.RecoveryRequired,
            message: "the filesystem was restored but the capture journal remains pending",
            details: { journalId, phase: "capture-abort" },
          });
        }
      }
    }

    if (request.backup) {
      const backups = this.dependencies.backups;
      if (!backups) {
        const restored = await this.restoreCapturedSteps(steps, captures, new Set());
        if (!restored) return this.orphanCapturedMutation(request, journalId, captures, "backup_unavailable");
        return this.abortRestoredMutation(
          request,
          journalId,
          captures,
          { code: ErrorCode.BackupFailed, message: "backup storage is unavailable" },
          "backup-abort",
        );
      }
      try {
        const sources = steps.flatMap((item) => {
          if (item.intent.kind === "mkdir" || item.intent.kind === "rmdir") return [];
          const capture = captures[item.intent.ordinal];
          return item.intent.fromHash === null || !capture?.rollbackPath
            ? []
            : [{
              path: item.step.kind === "entity"
                ? item.entityState?.backingPath ?? "preview-settings.json" as RelPath
                : item.step.path,
              resolved: capture.rollbackPath,
            }];
        });
        const manifest = await backups.create(
          request.ref.id,
          `tool:${request.toolAudit?.tool ?? "composite"}`,
          sources,
        );
        backupId = manifest.id;
        if (!(await backups.verify(manifest.id))) throw new Error("backup verification failed");
        await this.dependencies.compositeJournal.attachBackup(journalId, manifest.id);
      } catch {
        const restored = await this.restoreCapturedSteps(steps, captures, new Set());
        if (!restored) return this.orphanCapturedMutation(request, journalId, captures, "backup");
        return this.abortRestoredMutation(
          request,
          journalId,
          captures,
          { code: ErrorCode.BackupFailed, message: "the mutation backup could not be verified" },
          "backup-abort",
        );
      }
    }

    const historyEnabled = advancesSource && request.origin.historyAction !== "ignore";
    const retainedResult = await this.retainCompositeContent(steps, captures, historyEnabled);
    if (!retainedResult.ok) {
      const restored = await this.restoreCapturedSteps(steps, captures, new Set());
      if (!restored) return this.orphanCapturedMutation(request, journalId, captures, "history-retain");
      return this.abortRestoredMutation(
        request,
        journalId,
        captures,
        retainedResult.error,
        "history-retain-abort",
      );
    }
    const retained = retainedResult.value;
    let historyClaimed = false;
    const abandonHistory = () => {
      if (historyClaimed) this.dependencies.observer?.abortHistoryOperation(request.ref.id, request.origin);
      this.dependencies.undoContent?.release(retained.refs);
      historyClaimed = false;
    };
    const invalidateHistory = () => {
      this.dependencies.undoContent?.release(retained.refs);
      this.dependencies.observer?.invalidateProject(request.ref.id, "history-desync");
      historyClaimed = false;
    };
    if (request.origin.historyAction === "undo" || request.origin.historyAction === "redo") {
      const claimed = this.dependencies.observer?.claimHistoryOperation(request.ref.id, request.origin)
        ?? { ok: false as const, reason: "history observer is unavailable" };
      if (!claimed.ok) {
        const restored = await this.restoreCapturedSteps(steps, captures, new Set());
        if (!restored) {
          abandonHistory();
          return this.orphanCapturedMutation(request, journalId, captures, "history-claim");
        }
        this.dependencies.undoContent?.release(retained.refs);
        return this.abortRestoredMutation(
          request,
          journalId,
          captures,
          conflict({ reason: claimed.reason }, "historyOperation"),
          "history-claim-abort",
        );
      }
      historyClaimed = true;
    }

    let trackerArmed = false;
    try {
      this.dependencies.writtenStates?.arm(request.ref.id, journalId, steps.map((item) => {
        const path = item.step.kind === "entity" ? item.entityState!.backingPath : item.step.path;
        if (item.intent.kind === "mkdir" || item.intent.kind === "rmdir") {
          return {
            path,
            before: item.intent.existedBefore ? { kind: "directory" as const } : { kind: "absent" as const },
            after: item.intent.kind === "mkdir" ? { kind: "directory" as const } : { kind: "absent" as const },
          };
        }
        return {
          path,
          before: item.intent.fromHash === null
            ? { kind: "absent" as const }
            : { kind: "file" as const, contentHash: item.intent.fromHash },
          after: item.intent.toHash === null
            ? { kind: "absent" as const }
            : { kind: "file" as const, contentHash: item.intent.toHash },
        };
      }));
      trackerArmed = this.dependencies.writtenStates !== undefined;
    } catch {
      trackerArmed = false;
    }
    const settleWrittenStates = (outcome: "committed" | "rolled_back" | "unknown") => {
      if (!trackerArmed) return;
      try { this.dependencies.writtenStates?.settle(journalId, outcome); } catch {}
      trackerArmed = false;
    };

    const published = new Set<number>();
    try {
      for (const item of steps) {
        const capture = captures[item.intent.ordinal];
        if (!capture) throw new Error("a mutation capture was lost before publish");
        if (!(await this.dependencies.workspace.revalidateMutationPath(item.lease))) {
          const restored = await this.restoreCapturedSteps(steps, captures, published);
          if (!restored) {
            settleWrittenStates("unknown");
            abandonHistory();
            return this.orphanCapturedMutation(request, journalId, captures, "publish_parent_identity");
          }
          await this.dependencies.compositeJournal.abortComposite(
            journalId,
            ErrorCode.WriteConflict,
            request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
          );
          await this.discardCaptures(captures);
          settleWrittenStates("rolled_back");
          abandonHistory();
          return err(conflict({}, "path"));
        }
        let landed: boolean;
        if (item.step.kind === "mkdir" || item.step.kind === "rmdir") {
          landed = await this.dependencies.workspace.publishCaptured(
            capture,
            { kind: "directory", action: item.step.kind },
          );
        } else if (item.step.kind === "write-staged" || (!advancesSource && item.step.kind === "write"
          && (item.content instanceof Uint8Array || isStagedFileSource(item.content)))) {
          const stager = this.dependencies.stagedAssets;
          if (!stager) throw new Error("staged file publishing is unavailable");
          const staged = isStagedFileSource(item.content)
            ? await stager.stageFile(
                item.target,
                item.step.path,
                item.content.sourcePath,
                item.content.contentHash,
                { createParent: item.step.kind !== "write-staged" },
              )
            : item.content instanceof Uint8Array
              ? await stager.stage(item.target, item.step.path, item.content)
              : null;
          if (!staged) throw new Error("staged publish content is invalid");
          try {
            if (staged.contentHash !== item.intent.toHash) {
              throw new Error("staged artifact hash differs from the journal intent");
            }
            if (!(await this.dependencies.workspace.revalidateMutationPath(item.lease))) {
              throw new Error("staged target parent identity changed before commit");
            }
            await staged.commit();
            landed = await this.dependencies.workspace.readHash(item.target) === item.intent.toHash;
          } catch (error) {
            await staged.cleanup().catch(() => {});
            throw error;
          }
        } else {
          if (isStagedFileSource(item.content)) throw new Error("staged file source reached an unsupported publish path");
          landed = await this.dependencies.workspace.publishCaptured(
            capture,
            item.step.kind === "delete" ? null : item.content,
          );
        }
        if (!landed) {
          const restored = await this.restoreCapturedSteps(steps, captures, published);
          if (!restored) {
            settleWrittenStates("unknown");
            abandonHistory();
            return this.orphanCapturedMutation(request, journalId, captures, "publish_conflict");
          }
          await this.dependencies.compositeJournal.abortComposite(
            journalId,
            ErrorCode.WriteConflict,
            request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
          );
          await this.discardCaptures(captures);
          settleWrittenStates("rolled_back");
          abandonHistory();
          return err(conflict({}, "expectedContentHash"));
        }
        published.add(item.intent.ordinal);
      }
    } catch {
      const rolledBack = await this.restoreCapturedSteps(steps, captures, published);
      if (rolledBack) {
        try {
          await this.dependencies.compositeJournal.abortComposite(
            journalId,
            ErrorCode.StorageUnavailable,
            request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
          );
          await this.discardCaptures(captures);
          settleWrittenStates("rolled_back");
          abandonHistory();
          return err({ code: ErrorCode.StorageUnavailable, message: "a composite filesystem step failed" });
        } catch {
          const reconciled = await this.reconcileCompositeOnce(journalId);
          settleWrittenStates(reconciled?.ok && ["aborted", "rolled_back"].includes(reconciled.value.terminal)
            ? "rolled_back"
            : "unknown");
          abandonHistory();
          return reconciled?.ok && ["aborted", "rolled_back"].includes(reconciled.value.terminal)
            ? err({ code: ErrorCode.StorageUnavailable, message: "a composite filesystem step failed" })
            : err({
                code: ErrorCode.RecoveryRequired,
                message: "the filesystem was restored but the journal remains pending",
                details: { journalId, phase: "abort" },
              });
        }
      }
      try {
        await this.dependencies.compositeJournal.orphanComposite(
          journalId,
          ErrorCode.RecoveryRequired,
          request.grant
            ? { kind: "invalidate", grantId: request.grant.id, reason: "rollback_failed" }
            : undefined,
        );
      } catch {
        // The durable T1 remains pending and still owns its audit context.
        await this.reconcileCompositeOnce(journalId);
      }
      settleWrittenStates("unknown");
      invalidateHistory();
      return err({
        code: ErrorCode.RecoveryRequired,
        message: "the composite mutation could not be rolled back safely",
        details: { journalId, phase: "rollback" },
      });
    }

    const single = steps.length === 1 ? steps[0] : null;
    const changedPaths = steps.map((item) => item.step.kind === "entity"
      ? item.entityState!.backingPath
      : item.step.path);
    const event: DomainEvent = single?.step.kind === "entity"
      ? {
          type: "project.changed",
          projectId: request.ref.id,
          payload: { entity: single.step.entity, paths: changedPaths, source: request.origin.kind },
        }
      : single
        ? {
            type: "file.changed",
            projectId: request.ref.id,
            payload: { path: single.step.path, paths: changedPaths, source: request.origin.kind },
          }
        : {
            type: "project.changed",
            projectId: request.ref.id,
            payload: { composite: true, paths: changedPaths, source: request.origin.kind },
          };
    try {
      const result = {
        projectId: request.ref.id,
        actor,
        steps: steps.map(({ intent }) => ({ ...intent, status: "written" as const })),
        diagnostics: request.diagnostics ?? [],
        event,
      };
      const committedEnvelope = advancesSource
        ? await this.dependencies.compositeJournal.commitComposite(
            journalId,
            result,
            request.grant ? { kind: "consume", grantId: request.grant.id } : undefined,
          )
        : await this.dependencies.compositeJournal.commitDerivedComposite(journalId, result);
      settleWrittenStates("committed");
      const envelope = this.deliverReceipt(
        request,
        journalId,
        steps,
        retained,
        committedEnvelope,
        historyEnabled,
      );
      historyClaimed = false;
      if (!this.dependencies.writtenStates) {
        for (const [path, hash] of Object.entries(envelope.fileHashes)) {
          this.dependencies.recordWrittenHash?.(request.ref.id, path as RelPath, hash);
        }
      }
      (this.dependencies.pathInvalidator ?? {
        invalidate: (projectId: ProjectId) => this.dependencies.invalidate(projectId),
      }).invalidate(request.ref.id, changedPaths);
      this.dependencies.notifyEvents();
      const finalized = await this.discardCommittedCaptures(captures, envelope);
      return ok({ ...finalized, ...(backupId ? { backupId } : {}) });
    } catch {
      const reconciled = await this.reconcileCompositeOnce(journalId);
      if (reconciled?.ok && reconciled.value.terminal === "committed") {
        settleWrittenStates("committed");
        const envelope = this.deliverReceipt(
          request,
          journalId,
          steps,
          retained,
          reconciled.value.envelope,
          historyEnabled,
        );
        historyClaimed = false;
        if (!this.dependencies.writtenStates) {
          for (const [path, hash] of Object.entries(envelope.fileHashes)) {
            this.dependencies.recordWrittenHash?.(request.ref.id, path as RelPath, hash);
          }
        }
        (this.dependencies.pathInvalidator ?? {
          invalidate: (projectId: ProjectId) => this.dependencies.invalidate(projectId),
        }).invalidate(request.ref.id, changedPaths);
        this.dependencies.notifyEvents();
        const finalized = await this.discardCommittedCaptures(captures, envelope);
        return ok({ ...finalized, ...(backupId ? { backupId } : {}) });
      }
      settleWrittenStates("unknown");
      invalidateHistory();
      return err({
        code: ErrorCode.RecoveryRequired,
        message: "the filesystem landed but the terminal transaction is unresolved",
        details: { journalId, phase: "commit" },
      });
    }
  }

  private async restoreCapturedSteps(
    steps: ValidatedCompositeStep[],
    captures: MutationCapture[],
    published: ReadonlySet<number>,
  ): Promise<boolean> {
    for (const capture of [...captures].reverse()) {
      const item = steps[capture.ordinal];
      if (!item) return false;
      try {
        if (capture.kind === "directory") {
          if (item.intent.kind !== "mkdir" && item.intent.kind !== "rmdir") return false;
          const current = await this.dependencies.workspace.stat(capture.target);
          const currentExists = current?.kind === "directory";
          const landedState = {
            kind: "directory" as const,
            exists: published.has(capture.ordinal)
              ? item.intent.kind === "mkdir"
              : item.intent.existedBefore,
          };
          if (currentExists !== landedState.exists) return false;
          if (!(await this.dependencies.workspace.restoreCaptured(capture, landedState))) return false;
          const restored = await this.dependencies.workspace.stat(capture.target);
          if ((restored?.kind === "directory") !== item.intent.existedBefore) return false;
          if (capture.existedBefore && !currentExists) {
            for (const earlier of captures) {
              if (earlier.ordinal >= capture.ordinal || !earlier.lease
                || !earlier.lease.parents.some((parent) => parent.path === capture.target)) continue;
              const refreshed = await this.dependencies.workspace.refreshMutationPath(
                earlier.lease,
                capture.target,
              );
              if (!refreshed) return false;
              earlier.lease = refreshed;
            }
          }
          continue;
        }
        const actual = await this.dependencies.workspace.readHash(capture.target);
        const landedHash = published.has(capture.ordinal) ? item.intent.toHash : null;
        if (actual !== landedHash) {
          // Atomic publish yields only `toHash`; any other complete value belongs to an external editor.
          await this.dependencies.workspace.discardCapture(capture);
          continue;
        }
        if (!(await this.dependencies.workspace.restoreCaptured(capture, landedHash))) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async discardCaptures(captures: MutationCapture[]): Promise<void> {
    for (const capture of captures) await this.dependencies.workspace.discardCapture(capture);
  }

  private async discardCommittedCaptures(
    captures: MutationCapture[],
    envelope: WriteEnvelope,
  ): Promise<WriteEnvelope> {
    try {
      await this.discardCaptures(captures);
      return envelope;
    } catch {
      return {
        ...envelope,
        diagnostics: [...envelope.diagnostics, {
          severity: "warning",
          code: "capture-cleanup-unavailable",
          message: "committed mutation cleanup remains pending",
        }],
      };
    }
  }

  private async abortRestoredMutation(
    request: CompositeRequest,
    journalId: JournalId,
    captures: MutationCapture[],
    failure: DomainError,
    phase: string,
  ): Promise<Result<WriteEnvelope, DomainError>> {
    try {
      const settled = await this.dependencies.compositeJournal.abortComposite(
        journalId,
        failure.code,
        request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
      );
      if (settled !== null) {
        await this.discardCaptures(captures);
        return err(failure);
      }
    } catch {
      // Inline reconciliation below is the durable authority when T2a fails.
    }
    const reconciled = await this.reconcileCompositeOnce(journalId);
    if (reconciled?.ok && ["aborted", "rolled_back"].includes(reconciled.value.terminal)) {
      await this.discardCaptures(captures);
      return err(failure);
    }
    return err({
      code: ErrorCode.RecoveryRequired,
      message: "the filesystem was restored but the backup journal remains unresolved",
      details: { journalId, phase },
    });
  }

  private async orphanCapturedMutation(
    request: CompositeRequest,
    journalId: JournalId,
    captures: MutationCapture[],
    phase: string,
  ): Promise<Result<WriteEnvelope, DomainError>> {
    try {
      await this.dependencies.compositeJournal.orphanComposite(
        journalId,
        ErrorCode.RecoveryRequired,
        request.grant
          ? { kind: "invalidate", grantId: request.grant.id, reason: "rollback_failed" }
          : undefined,
      );
    } catch {
      await this.reconcileCompositeOnce(journalId);
    }
    return err({
      code: ErrorCode.RecoveryRequired,
      message: "the mutation capture could not be settled without overwriting external changes",
      details: { journalId, phase, captures: captures.length },
    });
  }

  private compositeStorageError(error: unknown, message: string): DomainError {
    if (typeof error === "object" && error !== null && "code" in error
      && Object.values(ErrorCode).includes(error.code as ErrorCode)) {
      return { code: error.code as ErrorCode, message };
    }
    return { code: ErrorCode.StorageUnavailable, message };
  }

  private async reconcileCompositeOnce(
    journalId: JournalId,
  ): Promise<Result<CompositeReconcileOutcome, DomainError> | null> {
    if (!this.dependencies.reconcileJournal) return null;
    try {
      return await this.dependencies.reconcileJournal(journalId);
    } catch {
      return null;
    }
  }

  /** Atomically coordinates a staged BGM asset with its preview-settings entity mutation. */
  async uploadBgm(request: {
    ref: ProjectRef;
    name: string;
    path: RelPath;
    bytes: Uint8Array;
    expectedRevision: number;
    /** Merged into the same mutation; omitted leaves whatever the project had. */
    volume?: number;
    loop?: boolean;
  }, actor: Actor, invocation: WriteInvocation = {
    origin: ignoredMutationOriginForActor(actor),
    toolAudit: null,
  }): Promise<Result<WriteResult, DomainError>> {
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    const stagedAssets = this.dependencies.stagedAssets;
    if (!stagedAssets) {
      return err({ code: ErrorCode.StorageUnavailable, message: "asset staging is unavailable" });
    }
    return this.mutex.run(request.ref.id, async () => {
      if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
        return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
      }
      const state = await this.dependencies.journal.readEntityState(request.ref.id, "preview-settings");
      if (!state) return err({ code: ErrorCode.Internal, message: "entity state has not been initialized" });
      const settingsPath = await this.dependencies.workspace.resolve(request.ref, state.backingPath, "system-write");
      const assetPath = await this.dependencies.workspace.resolve(request.ref, request.path, "write-asset");
      if (!settingsPath.ok || !assetPath.ok) return err({ code: ErrorCode.AssetNotAllowed, message: "BGM path was rejected" });
      const current = await this.dependencies.workspace.readFile(settingsPath.value);
      const physicalHash = current?.contentHash ?? this.dependencies.hashContent(serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS));
      if (request.expectedRevision !== state.revision || physicalHash !== state.contentHash) {
        return err(conflict({ current: { contentHash: physicalHash, revision: state.revision } }, "expectedRevision"));
      }
      let raw: unknown = DEFAULT_PREVIEW_SETTINGS;
      if (current) try { raw = JSON.parse(current.content); } catch { raw = DEFAULT_PREVIEW_SETTINGS; }
      const previewSettings = mergePreviewSettings(normalizePreviewSettings(raw), {
        bgm: {
          enabled: true,
          track: { name: request.name, path: request.path },
          ...(request.volume === undefined ? {} : { volume: request.volume }),
          ...(request.loop === undefined ? {} : { loop: request.loop }),
        },
      });
      const content = serializePreviewSettings(previewSettings);
      const nextHash = this.dependencies.hashContent(content);
      let staged;
      try { staged = await stagedAssets.stage(assetPath.value, request.path, request.bytes); }
      catch {
        return err({ code: ErrorCode.WriteConflict, message: "a BGM asset with this name already exists" });
      }
      const intent = {
        projectId: request.ref.id,
        kind: "entity" as const,
        path: null,
        entity: "preview-settings" as const,
        fromHash: physicalHash,
        previousContent: current?.content ?? null,
        toHash: nextHash,
        actor,
        stagedAsset: {
          temporaryPath: staged.temporaryPath,
          targetPath: staged.targetPath,
          contentHash: staged.contentHash,
        },
      };
      const journalId = await this.dependencies.journal.begin(intent, invocation.toolAudit);
      let settingsWritten = false;
      try {
        const [liveAssetPath, liveSettingsPath] = await Promise.all([
          this.dependencies.workspace.resolve(request.ref, request.path, "write-asset"),
          this.dependencies.workspace.resolve(request.ref, state.backingPath, "system-write"),
        ]);
        if (!liveAssetPath.ok || liveAssetPath.value !== assetPath.value
          || !liveSettingsPath.ok || liveSettingsPath.value !== settingsPath.value
          || await this.dependencies.workspace.readHash(liveSettingsPath.value) !== (current?.contentHash ?? null)) {
          await staged.cleanup().catch(() => {});
          await this.dependencies.journal.abort(journalId, ErrorCode.WriteConflict).catch(() => {});
          return err({ code: ErrorCode.WriteConflict, message: "the BGM mutation paths changed before commit" });
        }
        await staged.commit();
        await this.dependencies.workspace.writeAtomic(liveSettingsPath.value, content);
        settingsWritten = true;
        const revision = await this.dependencies.journal.commit(journalId, {
          ...intent,
          event: { type: "project.changed", projectId: request.ref.id, payload: { entity: "preview-settings" } },
        });
        this.dependencies.recordWrittenHash?.(request.ref.id, request.path, this.dependencies.hashContent(request.bytes));
        this.dependencies.recordWrittenHash?.(request.ref.id, state.backingPath, nextHash);
        this.dependencies.invalidate(request.ref.id);
        this.dependencies.notifyEvents();
        return ok({ path: null, contentHash: nextHash, revision, diagnostics: [], previewSettings });
      } catch {
        if (!settingsWritten) {
          await staged.cleanup().catch(() => {});
          await this.dependencies.journal.abort(journalId, ErrorCode.StorageUnavailable).catch(() => {});
        }
        return err({ code: ErrorCode.StorageUnavailable, message: "BGM mutation could not be persisted" });
      }
    });
  }

  /** Executes one authored single-target mutation; callers cannot choose a path purpose. */
  async mutateSource(
    request: MutationRequest,
    actor: Actor,
    invocation?: WriteInvocation,
  ): Promise<Result<WriteResult, DomainError>>;
  async mutateSource(
    request: CompositeRequest,
    actor: Actor,
  ): Promise<Result<WriteEnvelope, DomainError>>;
  async mutateSource(
    request: MutationRequest | CompositeRequest,
    actor: Actor,
    invocation: WriteInvocation = {
      origin: ignoredMutationOriginForActor(actor),
      toolAudit: null,
    },
  ): Promise<Result<WriteResult | WriteEnvelope, DomainError>> {
    if ("steps" in request) return this.executeComposite(request, actor, true);
    const composite = await this.executeComposite({
      ref: request.ref,
      steps: request.kind === "file"
        ? [{
            kind: "write",
            path: request.path,
            content: request.content,
            expectedContentHash: request.expectedContentHash as ContentHash | null,
          }]
        : [{
            kind: "entity",
            entity: request.entity,
            patch: request.patch,
            expectedRevision: request.expectedRevision,
          }],
      ...invocation,
      backup: false,
    }, actor, true);
    if (!composite.ok) {
      return composite.error.code === ErrorCode.RecoveryRequired && invocation.toolAudit === null
        ? err({ code: ErrorCode.StorageUnavailable, message: "the project mutation could not be committed" })
        : composite;
    }
    if (request.kind === "file") {
      return ok({
        path: request.path,
        contentHash: composite.value.fileHashes[request.path] ?? this.dependencies.hashContent(request.content),
        revision: composite.value.projectRevision,
        diagnostics: composite.value.diagnostics,
        changeSeq: composite.value.changeSeq,
      });
    }
    const state = await this.dependencies.journal.readEntityState(request.ref.id, request.entity);
    if (!state) return err({ code: ErrorCode.Internal, message: "entity state disappeared after commit" });
    const resolved = await this.dependencies.workspace.resolve(request.ref, state.backingPath, "system-write");
    if (!resolved.ok) return err(pathError(resolved.error));
    const file = await this.dependencies.workspace.readFile(resolved.value);
    let raw: unknown = DEFAULT_PREVIEW_SETTINGS;
    if (file) try { raw = JSON.parse(file.content); } catch { raw = DEFAULT_PREVIEW_SETTINGS; }
    return ok({
      path: null,
      contentHash: composite.value.fileHashes[state.backingPath] ?? state.contentHash,
      revision: composite.value.entityRevision ?? state.revision,
      diagnostics: composite.value.diagnostics,
      changeSeq: composite.value.changeSeq,
      previewSettings: normalizePreviewSettings(raw),
    });
  }

  /** Executes one derived composite; only `.vidcom`, snapshot and render targets are reachable. */
  async mutateDerived(
    request: DerivedMutationRequest,
    actor: Actor,
  ): Promise<Result<WriteEnvelope, DomainError>> {
    if (request.writes.length === 0) {
      return err({ code: ErrorCode.SchemaInvalid, message: "a derived mutation must contain at least one write" });
    }
    if (!Number.isSafeInteger(request.computedAtSourceRevision) || request.computedAtSourceRevision < 0) {
      return err({
        code: ErrorCode.SchemaInvalid,
        message: "computedAtSourceRevision must be a non-negative safe integer",
        field: "computedAtSourceRevision",
      });
    }
    const seen = new Set<RelPath>();
    const steps: CompositeStep[] = [];
    for (const write of request.writes) {
      if (seen.has(write.path)) {
        return err({
          code: ErrorCode.DuplicateMutationTarget,
          message: "a derived mutation cannot write the same path twice",
          details: { path: write.path },
        });
      }
      seen.add(write.path);
      const purpose = inferMutationPurpose("derived", write.path);
      if (purpose === null) return err(pathError({ reason: "not_allowed_for_purpose" }));
      const target = await this.dependencies.workspace.resolve(request.ref, write.path, purpose);
      if (!target.ok) return err(pathError(target.error));
      steps.push({
        kind: "write",
        path: write.path,
        content: write.content,
        expectedContentHash: await this.dependencies.workspace.readHash(target.value),
      });
    }
    return this.executeComposite({
      ref: request.ref,
      steps,
      origin: ignoredMutationOriginForActor(actor),
      toolAudit: null,
      commandAudit: {
        action: "derived.write",
        detail: {
          producedByJobId: request.producedByJobId,
          computedAtSourceRevision: request.computedAtSourceRevision,
        },
      },
      backup: false,
    }, actor, false);
  }

  /** Delegates workspace-root writes through the internal coordinator without creating a project revision/event. */
  async mutateWorkspace(
    request: WorkspaceWriteRequest,
  ): Promise<Result<WorkspaceWriteEnvelope, DomainError>> {
    if (!this.dependencies.workspaceCoordinator) {
      return err({
        code: ErrorCode.StorageUnavailable,
        message: "workspace mutation coordination is unavailable",
      });
    }
    return this.dependencies.workspaceCoordinator.mutate(request);
  }

  createProjectRoot(request: WorkspaceProjectCreateRequest): Promise<Result<ProjectRef, DomainError>> {
    return this.dependencies.workspaceCoordinator
      ? this.dependencies.workspaceCoordinator.createProjectRoot(request)
      : Promise.resolve(err({ code: ErrorCode.StorageUnavailable, message: "project lifecycle coordination is unavailable" }));
  }

  renameProjectRoot(request: WorkspaceProjectRenameRequest): Promise<Result<WorkspaceProjectLocation, DomainError>> {
    return this.dependencies.workspaceCoordinator
      ? this.dependencies.workspaceCoordinator.renameProjectRoot(request)
      : Promise.resolve(err({ code: ErrorCode.StorageUnavailable, message: "project lifecycle coordination is unavailable" }));
  }

  deleteProjectRoot(request: WorkspaceProjectDeleteRequest): Promise<Result<{ backupId: string }, DomainError>> {
    return this.dependencies.workspaceCoordinator
      ? this.dependencies.workspaceCoordinator.deleteProjectRoot(request)
      : Promise.resolve(err({ code: ErrorCode.StorageUnavailable, message: "project lifecycle coordination is unavailable" }));
  }

  async adoptProjectIdentity(request: AdoptProjectIdentityRequest): Promise<Result<WriteResult, DomainError>> {
    const identityPath = "vidcom.json" as RelPath;
    const resolved = await this.dependencies.workspace.resolve(request.ref, identityPath, "system-write");
    if (!resolved.ok) return err(pathError(resolved.error));
    const current = await this.dependencies.workspace.readFile(resolved.value);
    if (request.expectedContentHash === undefined && current) {
      return err({ code: ErrorCode.WriteConflict, message: "project identity already exists" });
    }
    if (request.expectedContentHash !== undefined && current?.contentHash !== request.expectedContentHash) {
      return err({ code: ErrorCode.WriteConflict, message: "project identity changed before recovery" });
    }
    const previewPath = "preview-settings.json" as RelPath;
    const preview = await this.dependencies.workspace.resolve(request.ref, previewPath, "system-write");
    if (!preview.ok) return err(pathError(preview.error));
    const currentPreviewHash = await this.dependencies.workspace.readHash(preview.value);
    const previewHash = currentPreviewHash
      ?? this.dependencies.hashContent(serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS));
    const toHash = this.dependencies.hashContent(request.content);
    const journalId = await this.dependencies.journal.beginBootstrap({
      id: request.ref.id,
      workspaceRoot: request.workspaceRoot,
      slug: request.ref.slug,
      firstSeenAt: request.occurredAt,
      lastSeenAt: request.occurredAt,
    }, {
      revision: currentPreviewHash ? 1 : 0,
      contentHash: previewHash,
      backingPath: previewPath,
      actor: request.actor ?? "system",
      updatedAt: request.occurredAt,
    }, {
      projectId: request.ref.id,
      kind: "file",
      path: identityPath,
      entity: null,
      fromHash: current?.contentHash ?? null,
      previousContent: current?.content ?? null,
      toHash,
      actor: request.actor ?? "system",
    }, null, request.toolAudit ?? null);
    return this.completeBootstrapIdentity({
      ref: request.ref,
      journalId,
      content: request.content,
      previousContent: current?.content ?? null,
      fromHash: current?.contentHash ?? null,
      toHash,
      actor: request.actor,
    });
  }

  /** Completes a pre-journaled `vidcom.json` system write through the same authority and mutex. */
  async completeBootstrapIdentity(
    write: BootstrapIdentityWrite,
  ): Promise<Result<WriteResult, DomainError>> {
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    return this.mutex.run(write.ref.id, async () => {
      if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
        return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
      }
      const identityPath = "vidcom.json" as RelPath;
      const resolved = await this.dependencies.workspace.resolve(write.ref, identityPath, "system-write");
      if (!resolved.ok) return err(pathError(resolved.error));
      try {
        await this.dependencies.workspace.writeAtomic(resolved.value, write.content);
        const revision = await this.dependencies.journal.commit(write.journalId, {
          projectId: write.ref.id,
          kind: "file",
          path: identityPath,
          entity: null,
          fromHash: write.fromHash,
          toHash: write.toHash,
          actor: write.actor ?? "system",
          previousContent: write.previousContent,
          event: {
            type: "project.changed",
            projectId: write.ref.id,
            payload: { identity: "assigned" },
          },
        });
        this.dependencies.recordWrittenHash?.(write.ref.id, identityPath, write.toHash);
        this.dependencies.invalidate(write.ref.id);
        this.dependencies.notifyEvents();
        return ok({ path: identityPath, contentHash: write.toHash, revision, diagnostics: [] });
      } catch {
        return err({ code: ErrorCode.StorageUnavailable, message: "project identity could not be persisted" });
      }
    });
  }

  private async mutateFile(
    request: Extract<MutationRequest, { kind: "file" }>,
    actor: Actor,
  ): Promise<Result<WriteResult, DomainError>> {
    const formatError = validateExpectedHash(request.expectedContentHash);
    if (formatError) return err(formatError);
    const purpose = inferMutationPurpose("source", request.path);
    if (purpose === null) return err(pathError({ reason: "not_allowed_for_purpose" }));
    const resolved = await this.dependencies.workspace.resolve(request.ref, request.path, purpose);
    if (!resolved.ok) return err(pathError(resolved.error));
    const currentHash = await this.dependencies.workspace.readHash(resolved.value);
    if (currentHash !== null && request.expectedContentHash === null) {
      return err({
        code: ErrorCode.PreconditionRequired,
        message: "expectedContentHash is required for an existing file",
        field: "expectedContentHash",
      });
    }
    if (currentHash !== request.expectedContentHash) {
      const current = await this.dependencies.workspace.readFile(resolved.value);
      return err(
        conflict(
          {
            current: current
              ? {
                  content: current.content,
                  contentHash: current.contentHash,
                  revision: (await this.dependencies.journal.latestRevision(request.ref.id)) ?? 0,
                }
              : null,
          },
          "expectedContentHash",
        ),
      );
    }

    const nextHash = this.dependencies.hashContent(request.content);
    if (nextHash === currentHash) {
      return ok({
        path: request.path,
        contentHash: nextHash,
        revision: (await this.dependencies.journal.latestRevision(request.ref.id)) ?? 0,
        diagnostics: [],
      });
    }
    if (this.dependencies.validateFileContent) {
      const validation = await this.dependencies.validateFileContent(request.path, request.content);
      if (!validation.ok) return validation;
    }
    const previous = await this.dependencies.workspace.readFile(resolved.value);
    const intent = {
      projectId: request.ref.id,
      kind: "file" as const,
      path: request.path,
      entity: null,
      fromHash: currentHash,
      previousContent: previous?.content ?? null,
      toHash: nextHash,
      actor,
    };
    const journalId = await this.dependencies.journal.begin(intent);
    const writeTarget = await this.dependencies.workspace.resolve(request.ref, request.path, purpose);
    if (!writeTarget.ok || writeTarget.value !== resolved.value
      || await this.dependencies.workspace.readHash(writeTarget.value) !== currentHash) {
      await this.dependencies.journal.abort(journalId, ErrorCode.WriteConflict).catch(() => {});
      return err({ code: ErrorCode.WriteConflict, message: "the project path changed before it could be written" });
    }
    try {
      await this.dependencies.workspace.writeAtomic(writeTarget.value, request.content);
    } catch {
      await this.dependencies.journal.abort(journalId, ErrorCode.StorageUnavailable).catch(() => {});
      return err({ code: ErrorCode.StorageUnavailable, message: "the project mutation could not be persisted" });
    }
    try {
      const revision = await this.dependencies.journal.commit(journalId, {
        ...intent,
        event: { type: "file.changed", projectId: request.ref.id, payload: { path: request.path } },
      });
      this.dependencies.recordWrittenHash?.(request.ref.id, request.path, nextHash);
      this.dependencies.invalidate(request.ref.id);
      this.dependencies.notifyEvents();
      return ok({ path: request.path, contentHash: nextHash, revision, diagnostics: [] });
    } catch {
      return err({ code: ErrorCode.StorageUnavailable, message: "the project mutation could not be committed" });
    }
  }

  private async mutateEntity(
    request: Extract<MutationRequest, { kind: "entity" }>,
    actor: Actor,
  ): Promise<Result<WriteResult, DomainError>> {
    const state = await this.dependencies.journal.readEntityState(request.ref.id, request.entity);
    if (!state) {
      return err({ code: ErrorCode.Internal, message: "entity state has not been initialized" });
    }
    const resolved = await this.dependencies.workspace.resolve(request.ref, state.backingPath, "system-write");
    if (!resolved.ok) return err(pathError(resolved.error));
    const current = await this.dependencies.workspace.readFile(resolved.value);
    const defaultContent = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
    const physicalHash = current?.contentHash ?? this.dependencies.hashContent(defaultContent);
    let rawSettings: unknown = DEFAULT_PREVIEW_SETTINGS;
    if (current) {
      try {
        rawSettings = JSON.parse(current.content);
      } catch {
        rawSettings = DEFAULT_PREVIEW_SETTINGS;
      }
    }
    const currentSettings = normalizePreviewSettings(rawSettings);
    if (request.expectedRevision !== state.revision || physicalHash !== state.contentHash) {
      return err(
        conflict(
          {
            current: {
              previewSettings: currentSettings,
              contentHash: physicalHash,
              revision: state.revision,
            },
          },
          "expectedRevision",
        ),
      );
    }
    const previewSettings = mergePreviewSettings(currentSettings, request.patch);
    const content = serializePreviewSettings(previewSettings);
    const nextHash = this.dependencies.hashContent(content);
    const intent = {
      projectId: request.ref.id,
      kind: "entity" as const,
      path: null,
      entity: request.entity,
      fromHash: physicalHash,
      previousContent: current?.content ?? null,
      toHash: nextHash,
      actor,
    };
    const journalId = await this.dependencies.journal.begin(intent);
    const writeTarget = await this.dependencies.workspace.resolve(request.ref, state.backingPath, "system-write");
    if (!writeTarget.ok || writeTarget.value !== resolved.value
      || await this.dependencies.workspace.readHash(writeTarget.value) !== (current?.contentHash ?? null)) {
      await this.dependencies.journal.abort(journalId, ErrorCode.WriteConflict).catch(() => {});
      return err({ code: ErrorCode.WriteConflict, message: "the entity backing path changed before it could be written" });
    }
    try {
      await this.dependencies.workspace.writeAtomic(writeTarget.value, content);
    } catch {
      await this.dependencies.journal.abort(journalId, ErrorCode.StorageUnavailable).catch(() => {});
      return err({ code: ErrorCode.StorageUnavailable, message: "the project mutation could not be persisted" });
    }
    try {
      const revision = await this.dependencies.journal.commit(journalId, {
        ...intent,
        event: { type: "project.changed", projectId: request.ref.id, payload: { entity: request.entity } },
      });
      this.dependencies.recordWrittenHash?.(request.ref.id, state.backingPath, nextHash);
      this.dependencies.invalidate(request.ref.id);
      this.dependencies.notifyEvents();
      return ok({
        path: null,
        contentHash: nextHash,
        revision,
        diagnostics: [],
        previewSettings,
      });
    } catch {
      return err({ code: ErrorCode.StorageUnavailable, message: "the project mutation could not be committed" });
    }
  }
}
