import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type Diagnostic,
  type DomainError,
  type PreviewSettingsDto,
  type PreviewSettingsPatchDto,
  type RelPath,
  type ProjectId,
} from "@vidcom/contracts";

import type { CompositionModel } from "../domain/models";
import { normalizePreviewSettings } from "../domain/preview-settings";
import { err, ok, type Result } from "../error/result";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { ClockPort, CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { CompositeRequest, CompositeStep, GrantBinding, WriteEnvelope, WriteInvocation } from "../port/types";
import { canonicalizeJson } from "../service/canonical-json";

export interface DeletionPlan {
  removeMount: { file: RelPath; hostId: string };
  deleteFile: RelPath | null;
  keptFileReason: "shared-src" | "inline" | null;
  rootDuration: number;
  narrationFiles: RelPath[];
  previewSettingsPatch: PreviewSettingsPatchDto | null;
  targetHashes: Record<RelPath, ContentHash>;
  diagnostics: Diagnostic[];
}

export interface DeletionInputs {
  model: CompositionModel;
  sceneId: string;
  previewSettings: PreviewSettingsDto;
  previewSettingsRevision: number;
  previewSettingsHash: ContentHash;
  narration: {
    jsonPath: RelPath;
    jsonHash: ContentHash | null;
    wavPath: RelPath;
    wavHash: ContentHash | null;
  } | null;
}

/** Purely derives every target and effect of deleting one parsed scene. */
export function planSceneDeletion(inputs: DeletionInputs): Result<DeletionPlan, DomainError> {
  const scene = inputs.model.scenes.find((candidate) => candidate.id === inputs.sceneId);
  if (!scene) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found" });
  const entry = inputs.model.sources[0];
  if (!entry) return err({ code: ErrorCode.Internal, message: "composition entry source is missing" });

  const targetHashes: Record<RelPath, ContentHash> = { [entry.path]: entry.contentHash };
  let deleteFile: RelPath | null = null;
  let keptFileReason: DeletionPlan["keptFileReason"] = null;
  if (scene.src === null) {
    keptFileReason = "inline";
  } else {
    const shared = inputs.model.scenes.some((candidate) => candidate.id !== scene.id && candidate.src === scene.src);
    if (shared) {
      keptFileReason = "shared-src";
    } else {
      const source = inputs.model.sources.find((candidate) => candidate.path === scene.src);
      if (!source) return err({ code: ErrorCode.Internal, message: "scene source hash is missing" });
      deleteFile = scene.src as RelPath;
      targetHashes[source.path] = source.contentHash;
    }
  }

  const remaining = inputs.model.scenes.filter((candidate) => candidate.id !== scene.id);
  const rootDuration = remaining.length === 0
    ? 0
    : Math.max(...remaining.map((candidate) => candidate.start + candidate.duration));
  const diagnostics: Diagnostic[] = remaining.length === 0
    ? [{
        severity: "warning",
        code: "composition_empty",
        sceneId: scene.id,
        message: "The composition has no scenes after this deletion.",
      }]
    : [];

  const narrationFiles: RelPath[] = [];
  if (inputs.narration?.jsonHash) {
    narrationFiles.push(inputs.narration.jsonPath);
    targetHashes[inputs.narration.jsonPath] = inputs.narration.jsonHash;
  }
  if (inputs.narration?.wavHash) {
    narrationFiles.push(inputs.narration.wavPath);
    targetHashes[inputs.narration.wavPath] = inputs.narration.wavHash;
  }

  const previewSettingsPatch = inputs.sceneId in inputs.previewSettings.scenes
    ? { scenesRemove: [inputs.sceneId] }
    : null;
  if (previewSettingsPatch) targetHashes["preview-settings.json" as RelPath] = inputs.previewSettingsHash;

  return ok({
    removeMount: { file: entry.path, hostId: inputs.sceneId },
    deleteFile,
    keptFileReason,
    rootDuration,
    narrationFiles,
    previewSettingsPatch,
    targetHashes,
    diagnostics,
  });
}

/** Hashes the canonical plan representation through the injected platform digest. */
export function digestPlan(
  plan: DeletionPlan,
  hashContent: (content: string | Uint8Array) => ContentHash,
): ContentHash {
  return hashContent(canonicalizeJson(plan));
}

export interface PrepareSceneDeletionDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readFile" | "readHash">;
  composition: Pick<CompositionPort, "parseProject">;
  journal: Pick<MutationJournalPort, "latestRevision" | "readEntityState">;
  hashContent(content: string | Uint8Array): ContentHash;
}

/** Collects live deletion inputs and binds the exact pure plan for approval. */
export async function prepareSceneDeletion(
  dependencies: PrepareSceneDeletionDependencies,
  input: { projectId: ProjectId; sceneId: string; expectedRevision: number },
): Promise<Result<{ plan: DeletionPlan; binding: GrantBinding }, DomainError>> {
  try {
    const ref = await dependencies.workspace.readProjectRef(input.projectId);
    if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
    const [model, latestRevision, entityState] = await Promise.all([
      dependencies.composition.parseProject(ref),
      dependencies.journal.latestRevision(input.projectId),
      dependencies.journal.readEntityState(input.projectId, "preview-settings"),
    ]);
    if ((latestRevision ?? 0) !== input.expectedRevision) {
      return err({
        code: ErrorCode.WriteConflict,
        message: "project revision changed before deletion planning",
        details: { currentRevision: latestRevision ?? 0 },
      });
    }
    if (!entityState) return err({ code: ErrorCode.Internal, message: "preview settings state is unavailable" });
    const settingsTarget = await dependencies.workspace.resolve(ref, entityState.backingPath, "system-write");
    if (!settingsTarget.ok) return err({ code: ErrorCode.Internal, message: "preview settings target is unavailable" });
    const settingsFile = await dependencies.workspace.readFile(settingsTarget.value);
    let previewSettings;
    try { previewSettings = normalizePreviewSettings(settingsFile ? JSON.parse(settingsFile.content) : null); }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "preview settings could not be parsed" }); }

    const jsonPath = `narration/${input.sceneId}.json` as RelPath;
    const wavPath = `narration/${input.sceneId}.wav` as RelPath;
    const [jsonTarget, wavTarget] = await Promise.all([
      dependencies.workspace.resolve(ref, jsonPath, "system-write"),
      dependencies.workspace.resolve(ref, wavPath, "read-asset"),
    ]);
    const [jsonHash, wavHash] = await Promise.all([
      jsonTarget.ok ? dependencies.workspace.readHash(jsonTarget.value) : Promise.resolve(null),
      wavTarget.ok ? dependencies.workspace.readHash(wavTarget.value) : Promise.resolve(null),
    ]);
    const planned = planSceneDeletion({
      model,
      sceneId: input.sceneId,
      previewSettings,
      previewSettingsRevision: entityState.revision,
      previewSettingsHash: entityState.contentHash,
      narration: jsonHash || wavHash ? { jsonPath, jsonHash, wavPath, wavHash } : null,
    });
    if (!planned.ok) return planned;
    const binding: GrantBinding = {
      tool: "delete_scene",
      projectId: input.projectId,
      target: input.sceneId,
      expectedRevision: input.expectedRevision,
      planDigest: digestPlan(planned.value, dependencies.hashContent),
      targetHashes: planned.value.targetHashes,
    };
    return ok({ plan: planned.value, binding });
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "scene deletion could not be planned" });
  }
}

export interface DeleteSceneDependencies extends PrepareSceneDeletionDependencies {
  clock: ClockPort;
  composition: Pick<CompositionPort, "parseProject" | "applyOps">;
  journal: Pick<MutationJournalPort, "latestRevision" | "readEntityState">;
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readFile" | "readHash">;
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
}

/** Executes the re-planned, grant-bound scene deletion as one verified-backup composite. */
export async function deleteScene(
  dependencies: DeleteSceneDependencies,
  input: { projectId: ProjectId; sceneId: string; expectedRevision: number; grantId: string },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
): Promise<Result<{
  project: CompositionModel["project"];
  envelope: WriteEnvelope;
  deletedFile: RelPath | null;
  keptFileReason: DeletionPlan["keptFileReason"];
  backupId: string;
}, DomainError>> {
  const prepared = await prepareSceneDeletion(dependencies, input);
  if (!prepared.ok) return prepared;
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  let model: CompositionModel;
  try { model = await dependencies.composition.parseProject(ref); }
  catch { return err({ code: ErrorCode.StorageUnavailable, message: "composition could not be read" }); }
  const entryHash = prepared.value.plan.targetHashes[prepared.value.plan.removeMount.file];
  if (!entryHash) return err({ code: ErrorCode.Internal, message: "deletion plan entry hash is missing" });
  const applied = await dependencies.composition.applyOps(ref, prepared.value.plan.removeMount.file, [
    { kind: "removeElement", target: prepared.value.plan.removeMount.hostId },
    { kind: "setTiming", target: "@root", value: { duration: prepared.value.plan.rootDuration } },
  ]);
  if (!applied.ok) return applied;

  const steps: CompositeStep[] = [{
    kind: "write",
    path: prepared.value.plan.removeMount.file,
    content: applied.value,
    expectedContentHash: entryHash,
  }];
  if (prepared.value.plan.deleteFile) {
    const expectedContentHash = prepared.value.plan.targetHashes[prepared.value.plan.deleteFile];
    if (!expectedContentHash) return err({ code: ErrorCode.Internal, message: "deleted scene file hash is missing" });
    steps.push({ kind: "delete", path: prepared.value.plan.deleteFile, expectedContentHash });
  }
  for (const path of prepared.value.plan.narrationFiles) {
    const expectedContentHash = prepared.value.plan.targetHashes[path];
    if (!expectedContentHash) return err({ code: ErrorCode.Internal, message: "narration hash is missing" });
    steps.push({ kind: "delete", path, expectedContentHash });
  }
  if (prepared.value.plan.previewSettingsPatch) {
    const state = await dependencies.journal.readEntityState(input.projectId, "preview-settings");
    if (!state) return err({ code: ErrorCode.Internal, message: "preview settings state is unavailable" });
    steps.push({
      kind: "entity",
      entity: "preview-settings",
      patch: prepared.value.plan.previewSettingsPatch,
      expectedRevision: state.revision,
      undoable: true,
    });
  }

  const written = await dependencies.authority.mutateSource({
    ref,
    steps,
    ...invocation,
    diagnostics: prepared.value.plan.diagnostics,
    backup: true,
    grant: { id: input.grantId, binding: prepared.value.binding },
  }, actor);
  if (!written.ok) return written;
  const backupId = "backupId" in written.value && typeof written.value.backupId === "string"
    ? written.value.backupId
    : null;
  if (!backupId) return err({ code: ErrorCode.BackupFailed, message: "destructive mutation returned no backup ID" });
  const envelope: WriteEnvelope = {
    projectRevision: written.value.projectRevision,
    entityRevision: written.value.entityRevision,
    fileHashes: written.value.fileHashes,
    diagnostics: written.value.diagnostics,
    changeSeq: written.value.changeSeq,
  };
  return ok({
    project: {
      ...model.project,
      duration: prepared.value.plan.rootDuration,
      updatedAt: dependencies.clock.now().toISOString(),
      sceneCount: Math.max(0, model.project.sceneCount - 1),
      revision: envelope.projectRevision,
    },
    envelope,
    deletedFile: prepared.value.plan.deleteFile,
    keptFileReason: prepared.value.plan.keptFileReason,
    backupId,
  });
}
