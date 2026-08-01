import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type Diagnostic,
  type DomainError,
  type PreviewSettingsDto,
  type PreviewSettingsPatchDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { DEFAULT_PREVIEW_SETTINGS, mergePreviewSettings, normalizePreviewSettings, serializePreviewSettings } from "../domain/preview-settings";
import type { ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { LeasePort, MutationJournalPort, StagedAssetPort, WorkspacePort } from "../port/ports";
import type { PathRejection } from "../port/types";
import type { JournalId } from "../port/types";

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
  lease: LeasePort;
  leaseId: string;
  hashContent(content: string | Uint8Array): ContentHash;
  validateFileContent?(path: RelPath, content: string | Uint8Array): Promise<Result<void, DomainError>>;
  invalidate(projectId: ProjectId): void;
  recordWrittenHash?(projectId: ProjectId, path: RelPath, hash: ContentHash): void;
  notifyEvents(): void;
  stagedAssets?: StagedAssetPort;
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

/** Single project write authority enforcing lease, mutex, precondition, journal and event order. */
export class WriteAuthority {
  private readonly mutex = new ProjectMutex();

  constructor(private readonly dependencies: WriteAuthorityDependencies) {}

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

  /** Executes one file or entity mutation through the sole authorized write path. */
  async mutate(request: MutationRequest, actor: Actor): Promise<Result<WriteResult, DomainError>> {
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({
        code: ErrorCode.WorkspaceLeaseLost,
        message: "the workspace write lease was lost",
      });
    }
    return this.mutex.run(request.ref.id, async () => {
      if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
        return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
      }
      return request.kind === "file" ? this.mutateFile(request, actor) : this.mutateEntity(request, actor);
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
