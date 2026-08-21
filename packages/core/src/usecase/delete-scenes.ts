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

import type { CompositionModel } from "../domain/models";
import { normalizePreviewSettings } from "../domain/preview-settings";
import { err, ok, type Result } from "../error/result";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { ClockPort, CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { CompositeRequest, CompositeStep, GrantBinding, WriteEnvelope, WriteInvocation } from "../port/types";
import { canonicalizeJson } from "../service/canonical-json";

export interface DeleteScenesPlan {
  sceneIds: string[];
  entry: RelPath;
  deleteFiles: RelPath[];
  keptFiles: RelPath[];
  narrationFiles: RelPath[];
  rootDuration: number;
  previewSettingsPatch: PreviewSettingsPatchDto | null;
  targetHashes: Record<RelPath, ContentHash>;
  diagnostics: Diagnostic[];
}

interface DeleteScenesInputs {
  model: CompositionModel;
  sceneIds: string[];
  previewSettings: PreviewSettingsDto;
  previewSettingsHash: ContentHash;
  narrationHashes: Record<RelPath, ContentHash>;
}

function validateSceneIds(sceneIds: readonly string[]): Result<string[], DomainError> {
  if (sceneIds.length === 0) {
    return err({ code: ErrorCode.SchemaInvalid, message: "sceneIds must not be empty", field: "sceneIds" });
  }
  if (new Set(sceneIds).size !== sceneIds.length) {
    return err({
      code: ErrorCode.DuplicateMutationTarget,
      message: "sceneIds must be unique",
      field: "sceneIds",
    });
  }
  return ok([...sceneIds].sort((left, right) => left.localeCompare(right)));
}

export function planDeleteScenes(inputs: DeleteScenesInputs): Result<DeleteScenesPlan, DomainError> {
  const normalized = validateSceneIds(inputs.sceneIds);
  if (!normalized.ok) return normalized;
  const selectedIds = normalized.value;
  const selected = new Set(selectedIds);
  for (const sceneId of selectedIds) {
    if (!inputs.model.scenes.some((scene) => scene.id === sceneId)) {
      return err({ code: ErrorCode.SceneNotFound, message: "scene was not found", field: "sceneIds" });
    }
  }
  const entry = inputs.model.sources[0];
  if (!entry) return err({ code: ErrorCode.Internal, message: "composition entry source is missing" });
  const targetHashes: Record<RelPath, ContentHash> = { [entry.path]: entry.contentHash };
  const remaining = inputs.model.scenes.filter((scene) => !selected.has(scene.id));
  const remainingSources = new Set(remaining.flatMap((scene) => scene.src ? [scene.src] : []));
  const selectedSources = [...new Set(inputs.model.scenes
    .filter((scene) => selected.has(scene.id))
    .flatMap((scene) => scene.src ? [scene.src as RelPath] : []))]
    .sort((left, right) => left.localeCompare(right));
  const deleteFiles: RelPath[] = [];
  const keptFiles: RelPath[] = [];
  for (const path of selectedSources) {
    if (remainingSources.has(path)) {
      keptFiles.push(path);
      continue;
    }
    const source = inputs.model.sources.find((candidate) => candidate.path === path);
    if (!source) return err({ code: ErrorCode.Internal, message: "scene source hash is missing" });
    deleteFiles.push(path);
    targetHashes[path] = source.contentHash;
  }
  const narrationFiles = Object.keys(inputs.narrationHashes)
    .sort((left, right) => left.localeCompare(right)) as RelPath[];
  for (const path of narrationFiles) targetHashes[path] = inputs.narrationHashes[path]!;
  const previewSettingsPatch = selectedIds.some((sceneId) => sceneId in inputs.previewSettings.scenes)
    ? { scenesRemove: selectedIds }
    : null;
  if (previewSettingsPatch) targetHashes["preview-settings.json" as RelPath] = inputs.previewSettingsHash;
  const rootDuration = remaining.length === 0
    ? 0
    : Math.max(...remaining.map((scene) => scene.start + scene.duration));
  const diagnostics: Diagnostic[] = remaining.length === 0
    ? [{
        severity: "warning",
        code: "composition_empty",
        sceneId: selectedIds[0],
        message: "The composition has no scenes after this deletion.",
      }]
    : [];
  return ok({
    sceneIds: selectedIds,
    entry: entry.path,
    deleteFiles,
    keptFiles,
    narrationFiles,
    rootDuration,
    previewSettingsPatch,
    targetHashes,
    diagnostics,
  });
}

export interface PrepareDeleteScenesDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readFile" | "readHash">;
  composition: Pick<CompositionPort, "parseProject">;
  journal: Pick<MutationJournalPort, "latestRevision" | "readEntityState">;
  hashContent(content: string | Uint8Array): ContentHash;
}

export async function prepareDeleteScenes(
  dependencies: PrepareDeleteScenesDependencies,
  input: { projectId: ProjectId; sceneIds: string[]; expectedRevision: number },
): Promise<Result<{ plan: DeleteScenesPlan; binding: GrantBinding }, DomainError>> {
  const normalized = validateSceneIds(input.sceneIds);
  if (!normalized.ok) return normalized;
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
    let previewSettings: PreviewSettingsDto;
    try { previewSettings = normalizePreviewSettings(settingsFile ? JSON.parse(settingsFile.content) : null); }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "preview settings could not be parsed" }); }

    const narrationHashes: Record<RelPath, ContentHash> = {};
    for (const sceneId of normalized.value) {
      const jsonPath = `narration/${sceneId}.json` as RelPath;
      const wavPath = `narration/${sceneId}.wav` as RelPath;
      const [jsonTarget, wavTarget] = await Promise.all([
        dependencies.workspace.resolve(ref, jsonPath, "system-write"),
        dependencies.workspace.resolve(ref, wavPath, "read-asset"),
      ]);
      const [jsonHash, wavHash] = await Promise.all([
        jsonTarget.ok ? dependencies.workspace.readHash(jsonTarget.value) : Promise.resolve(null),
        wavTarget.ok ? dependencies.workspace.readHash(wavTarget.value) : Promise.resolve(null),
      ]);
      if (jsonHash) narrationHashes[jsonPath] = jsonHash;
      if (wavHash) narrationHashes[wavPath] = wavHash;
    }
    const planned = planDeleteScenes({
      model,
      sceneIds: normalized.value,
      previewSettings,
      previewSettingsHash: entityState.contentHash,
      narrationHashes,
    });
    if (!planned.ok) return planned;
    const binding: GrantBinding = {
      tool: "delete_scenes",
      projectId: input.projectId,
      target: canonicalizeJson(normalized.value),
      expectedRevision: input.expectedRevision,
      planDigest: dependencies.hashContent(canonicalizeJson(planned.value)),
      targetHashes: planned.value.targetHashes,
    };
    return ok({ plan: planned.value, binding });
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "scene deletion could not be planned" });
  }
}

export interface DeleteScenesDependencies extends PrepareDeleteScenesDependencies {
  clock: ClockPort;
  composition: Pick<CompositionPort, "parseProject" | "applyOps">;
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
}

export async function deleteScenes(
  dependencies: DeleteScenesDependencies,
  input: { projectId: ProjectId; sceneIds: string[]; expectedRevision: number; grantId: string },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
): Promise<Result<{
  project: CompositionModel["project"];
  envelope: WriteEnvelope;
  deletedFiles: RelPath[];
  keptFiles: RelPath[];
  backupId: string;
}, DomainError>> {
  const prepared = await prepareDeleteScenes(dependencies, input);
  if (!prepared.ok) return prepared;
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  let model: CompositionModel;
  try { model = await dependencies.composition.parseProject(ref); }
  catch { return err({ code: ErrorCode.StorageUnavailable, message: "composition could not be read" }); }
  const entryHash = prepared.value.plan.targetHashes[prepared.value.plan.entry];
  if (!entryHash) return err({ code: ErrorCode.Internal, message: "deletion plan entry hash is missing" });
  const applied = await dependencies.composition.applyOps(ref, prepared.value.plan.entry, [
    ...prepared.value.plan.sceneIds.map((sceneId) => ({ kind: "removeElement" as const, target: sceneId })),
    { kind: "setTiming" as const, target: "@root", value: { duration: prepared.value.plan.rootDuration } },
  ]);
  if (!applied.ok) return applied;
  const steps: CompositeStep[] = [{
    kind: "write",
    path: prepared.value.plan.entry,
    content: applied.value,
    expectedContentHash: entryHash,
  }];
  for (const path of [...prepared.value.plan.deleteFiles, ...prepared.value.plan.narrationFiles]) {
    const expectedContentHash = prepared.value.plan.targetHashes[path];
    if (!expectedContentHash) return err({ code: ErrorCode.Internal, message: "deleted file hash is missing" });
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
      sceneCount: Math.max(0, model.project.sceneCount - prepared.value.plan.sceneIds.length),
      revision: envelope.projectRevision,
    },
    envelope,
    deletedFiles: prepared.value.plan.deleteFiles,
    keptFiles: prepared.value.plan.keptFiles,
    backupId,
  });
}
