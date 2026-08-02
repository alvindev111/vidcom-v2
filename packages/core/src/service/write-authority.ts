import {
  ErrorCode,
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
import type { ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { BackupPort, CompositeMutationJournalPort, LeasePort, MutationJournalPort, StagedAssetPort, WorkspacePort } from "../port/ports";
import type {
  CompositeRequest,
  CompositeReconcileOutcome,
  CompositeStep,
  EntityState,
  PathPurpose,
  PathRejection,
  ResolvedPath,
  StepIntent,
  WriteEnvelope,
  WriteInvocation,
} from "../port/types";
import type { JournalId } from "../port/types";
import { canonicalizeJson } from "./canonical-json";

export type MutationRequest =
  | {
      kind: "file";
      ref: ProjectRef;
      path: RelPath;
      content: string | Uint8Array;
      expectedContentHash: string | null;
      /** Defaults to source writes; privileged internal flows must opt in explicitly. */
      purpose?: "write-source" | "system-write";
    }
  | {
      kind: "entity";
      ref: ProjectRef;
      entity: "preview-settings";
      patch: PreviewSettingsPatchDto;
      expectedRevision: number;
    };

/** Successful mutation payload returned to transport adapters. */
export interface WriteResult {
  path: RelPath | null;
  contentHash: ContentHash;
  revision: number;
  diagnostics: Diagnostic[];
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
  recordWrittenHash?(projectId: ProjectId, path: RelPath, hash: ContentHash): void;
  notifyEvents(): void;
  stagedAssets?: StagedAssetPort;
  backups?: BackupPort;
  reconcileJournal?(id: JournalId): Promise<Result<CompositeReconcileOutcome, DomainError>>;
}

/** Journal-first identity write prepared by `bootstrapProject`. */
export interface BootstrapIdentityWrite {
  ref: ProjectRef;
  journalId: JournalId;
  content: string;
  previousContent: string | null;
  fromHash: ContentHash | null;
  toHash: ContentHash;
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
      return { code: ErrorCode.AssetNotAllowed, message: "this file is not served" };
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

interface PreparedCompositeStep {
  step: CompositeStep;
  target: ResolvedPath;
  entityState: EntityState | null;
}

interface ValidatedCompositeStep extends PreparedCompositeStep {
  intent: StepIntent;
  content: string | Uint8Array | null;
  previewSettings: PreviewSettingsDto | null;
}

function deletePurpose(path: RelPath): PathPurpose {
  if (path === "preview-settings.json" || (path.startsWith("narration/") && path.endsWith(".json"))) {
    return "system-write";
  }
  if (["assets/", "preview-assets/", "narration/", "snapshots/", "renders/"].some((root) => path.startsWith(root))) {
    return "write-asset";
  }
  return "write-source";
}

/** Single project write authority enforcing lease, mutex, precondition, journal and event order. */
export class WriteAuthority {
  private readonly mutex = new ProjectMutex();

  constructor(private readonly dependencies: WriteAuthorityDependencies) {}

  /** Executes one ordered multi-target mutation only while the lease and project recovery gate permit writes. */
  async mutateComposite(
    request: CompositeRequest,
    actor: Actor,
  ): Promise<Result<WriteEnvelope, DomainError>> {
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
      const prepared = await this.resolveCompositeTargets(request);
      if (!prepared.ok) return prepared;
      const validated = await this.validateCompositePreconditions(request, prepared.value);
      if (!validated.ok) return validated;
      return this.executeValidatedComposite(request, validated.value, actor);
    });
  }

  private async resolveCompositeTargets(
    request: CompositeRequest,
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
        purpose = step.kind === "write" ? step.purpose ?? "write-source" : deletePurpose(step.path);
      }
      const resolved = await this.dependencies.workspace.resolve(request.ref, path, purpose);
      if (!resolved.ok) return err(pathError(resolved.error));
      if (canonicalTargets.has(resolved.value)) {
        return err({
          code: ErrorCode.DuplicateMutationTarget,
          message: "multiple mutation steps resolve to the same project target",
          details: { path },
        });
      }
      canonicalTargets.add(resolved.value);
      prepared.push({ step, target: resolved.value, entityState });
    }
    return ok(prepared);
  }

  private async validateCompositePreconditions(
    request: CompositeRequest,
    prepared: PreparedCompositeStep[],
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
        if (step.expectedRevision !== state.revision || physicalHash !== state.contentHash) {
          return err(conflict({
            current: { previewSettings: currentSettings, contentHash: physicalHash, revision: state.revision },
          }, "expectedRevision"));
        }
        const previewSettings = mergePreviewSettings(currentSettings, step.patch);
        const content = serializePreviewSettings(previewSettings);
        const toHash = this.dependencies.hashContent(content);
        observedHashes[state.backingPath] = physicalHash;
        validated.push({
          ...item,
          content,
          previewSettings,
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

      const formatError = validateExpectedHash(step.expectedContentHash);
      if (formatError) return err(formatError);
      const current = await this.dependencies.workspace.readBytes(item.target);
      const currentHash = current?.contentHash ?? null;
      if (step.kind === "write" && currentHash !== null && step.expectedContentHash === null) {
        return err({
          code: ErrorCode.PreconditionRequired,
          message: "expectedContentHash is required for an existing file",
          field: "expectedContentHash",
        });
      }
      if (currentHash !== step.expectedContentHash) {
        const currentFile = await this.dependencies.workspace.readFile(item.target);
        return err(conflict({
          current: currentFile
            ? {
                content: currentFile.content,
                contentHash: currentFile.contentHash,
                revision: (await this.dependencies.journal.latestRevision(request.ref.id)) ?? 0,
              }
            : null,
        }, "expectedContentHash"));
      }
      if (step.kind === "delete" && current === null) {
        return err({ code: ErrorCode.NotFound, message: "the deletion target was not found" });
      }
      if (currentHash !== null) observedHashes[step.path] = currentHash;
      validated.push({
        ...item,
        content: step.kind === "write" ? step.content : null,
        previewSettings: null,
        intent: step.kind === "write"
          ? {
              ordinal,
              kind: "write",
              path: step.path,
              entity: null,
              fromHash: currentHash,
              toHash: this.dependencies.hashContent(step.content),
              previousContent: current?.bytes ?? null,
            }
          : {
              ordinal,
              kind: "delete",
              path: step.path,
              entity: null,
              fromHash: currentHash,
              toHash: null,
              previousContent: current?.bytes ?? null,
            },
      });
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

  private async executeValidatedComposite(
    request: CompositeRequest,
    steps: ValidatedCompositeStep[],
    actor: Actor,
  ): Promise<Result<WriteEnvelope, DomainError>> {
    if (steps.every((item) => item.intent.kind !== "delete" && item.intent.fromHash === item.intent.toHash)) {
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
      return ok({ projectRevision, entityRevision, fileHashes, diagnostics: request.diagnostics ?? [] });
    }
    const grantReserve = request.grant
      ? { kind: "reserve" as const, grantId: request.grant.id, binding: request.grant.binding }
      : undefined;
    let journalId: JournalId;
    let backupId: string | null = null;
    try {
      journalId = await this.dependencies.compositeJournal.beginComposite(
        { projectId: request.ref.id, actor },
        steps.map(({ intent }) => intent),
        { toolAudit: request.toolAudit, ...(request.commandAudit ? { commandAudit: request.commandAudit } : {}) },
        grantReserve,
      );
    } catch (error) {
      return err(this.compositeStorageError(error, "composite mutation could not begin"));
    }

    if (request.backup) {
      const backups = this.dependencies.backups;
      if (!backups) {
        await this.dependencies.compositeJournal.abortComposite(
          journalId,
          ErrorCode.BackupFailed,
          request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
        ).catch(() => {});
        return err({ code: ErrorCode.BackupFailed, message: "backup storage is unavailable" });
      }
      try {
        const sources = steps.flatMap((item) => item.intent.fromHash === null
          ? []
          : [{
              path: item.step.kind === "entity"
                ? item.entityState?.backingPath ?? "preview-settings.json" as RelPath
                : item.step.path,
              resolved: item.target,
            }]);
        const manifest = await backups.create(
          request.ref.id,
          `tool:${request.toolAudit?.tool ?? "composite"}`,
          sources,
        );
        backupId = manifest.id;
        if (!(await backups.verify(manifest.id))) throw new Error("backup verification failed");
        await this.dependencies.compositeJournal.attachBackup(journalId, manifest.id);
      } catch {
        await this.dependencies.compositeJournal.abortComposite(
          journalId,
          ErrorCode.BackupFailed,
          request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
        ).catch(() => {});
        return err({ code: ErrorCode.BackupFailed, message: "the mutation backup could not be verified" });
      }
    }

    try {
      for (const item of steps) {
        if (item.step.kind === "delete") await this.dependencies.workspace.deleteAtomic(item.target);
        else if (item.content !== null) await this.dependencies.workspace.writeAtomic(item.target, item.content);
      }
    } catch {
      const rolledBack = await this.rollbackCompositeSteps(steps);
      if (rolledBack) {
        try {
          await this.dependencies.compositeJournal.abortComposite(
            journalId,
            ErrorCode.StorageUnavailable,
            request.grant ? { kind: "release", grantId: request.grant.id } : undefined,
          );
          return err({ code: ErrorCode.StorageUnavailable, message: "a composite filesystem step failed" });
        } catch {
          const reconciled = await this.reconcileCompositeOnce(journalId);
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
      return err({
        code: ErrorCode.RecoveryRequired,
        message: "the composite mutation could not be rolled back safely",
        details: { journalId, phase: "rollback" },
      });
    }

    const single = steps.length === 1 ? steps[0] : null;
    const event: DomainEvent = single?.step.kind === "entity"
      ? { type: "project.changed", projectId: request.ref.id, payload: { entity: single.step.entity } }
      : single
        ? { type: "file.changed", projectId: request.ref.id, payload: { path: single.step.path } }
        : { type: "project.changed", projectId: request.ref.id, payload: { composite: true } };
    try {
      const envelope = await this.dependencies.compositeJournal.commitComposite(
        journalId,
        {
          projectId: request.ref.id,
          actor,
          steps: steps.map(({ intent }) => ({ ...intent, status: "written" as const })),
          diagnostics: request.diagnostics ?? [],
          event,
        },
        request.grant ? { kind: "consume", grantId: request.grant.id } : undefined,
      );
      for (const [path, hash] of Object.entries(envelope.fileHashes)) {
        this.dependencies.recordWrittenHash?.(request.ref.id, path as RelPath, hash);
      }
      this.dependencies.invalidate(request.ref.id);
      this.dependencies.notifyEvents();
      return ok({ ...envelope, ...(backupId ? { backupId } : {}) });
    } catch {
      const reconciled = await this.reconcileCompositeOnce(journalId);
      if (reconciled?.ok && reconciled.value.terminal === "committed") {
        const envelope = reconciled.value.envelope;
        for (const [path, hash] of Object.entries(envelope.fileHashes)) {
          this.dependencies.recordWrittenHash?.(request.ref.id, path as RelPath, hash);
        }
        this.dependencies.invalidate(request.ref.id);
        this.dependencies.notifyEvents();
        return ok({ ...envelope, ...(backupId ? { backupId } : {}) });
      }
      return err({
        code: ErrorCode.RecoveryRequired,
        message: "the filesystem landed but the terminal transaction is unresolved",
        details: { journalId, phase: "commit" },
      });
    }
  }

  private async rollbackCompositeSteps(steps: ValidatedCompositeStep[]): Promise<boolean> {
    const landed: ValidatedCompositeStep[] = [];
    for (const item of steps) {
      let actual: ContentHash | null;
      try {
        actual = await this.dependencies.workspace.readHash(item.target);
      } catch {
        return false;
      }
      const isLanded = item.intent.kind === "delete"
        ? actual === null
        : actual === item.intent.toHash;
      const isOriginal = item.intent.fromHash === null
        ? actual === null
        : actual === item.intent.fromHash
          || (item.intent.kind === "entity" && item.intent.previousContent === null && actual === null);
      if (isLanded) landed.push(item);
      else if (!isOriginal) return false;
    }

    for (const item of landed.reverse()) {
      try {
        if (item.intent.fromHash === null) {
          await this.dependencies.workspace.deleteAtomic(item.target);
        } else {
          const previous = item.intent.previousContent;
          if (previous === null) return false;
          await this.dependencies.workspace.writeAtomic(item.target, previous);
        }
        const restored = await this.dependencies.workspace.readHash(item.target);
        if (restored !== item.intent.fromHash) return false;
      } catch {
        return false;
      }
    }
    return true;
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
  }, actor: Actor): Promise<Result<WriteResult, DomainError>> {
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
        bgm: { enabled: true, track: { name: request.name, path: request.path } },
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
      const journalId = await this.dependencies.journal.begin(intent);
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

  /** Executes one file or entity mutation through the composite authority while preserving the Phase-1 result shape. */
  async mutate(
    request: MutationRequest,
    actor: Actor,
    invocation: WriteInvocation = { toolAudit: null },
  ): Promise<Result<WriteResult, DomainError>> {
    const composite = await this.mutateComposite({
      ref: request.ref,
      steps: request.kind === "file"
        ? [{
            kind: "write",
            path: request.path,
            content: request.content,
            expectedContentHash: request.expectedContentHash as ContentHash | null,
            purpose: request.purpose,
          }]
        : [{
            kind: "entity",
            entity: request.entity,
            patch: request.patch,
            expectedRevision: request.expectedRevision,
          }],
      toolAudit: invocation.toolAudit,
      backup: false,
    }, actor);
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
      previewSettings: normalizePreviewSettings(raw),
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
          actor: "system",
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
    const purpose = request.purpose ?? "write-source";
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
