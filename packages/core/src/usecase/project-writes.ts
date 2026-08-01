import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type PreviewSettingsPatchDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import { validateSceneTiming } from "../domain/invariants";
import { err, ok, type Result } from "../error/result";
import type { ClockPort, CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { WriteAuthority } from "../service/write-authority";

export interface ProjectWriteDependencies {
  workspace: WorkspacePort;
  composition: CompositionPort;
  journal: MutationJournalPort;
  authority: Pick<WriteAuthority, "mutate"> & Partial<Pick<WriteAuthority, "uploadBgm">>;
  clock: ClockPort;
}

async function findRef(dependencies: ProjectWriteDependencies, id: ProjectId): Promise<Result<ProjectRef, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(id);
  return ref ? ok(ref) : err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
}

export async function saveSourceFile(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; path: RelPath; content: string; expectedContentHash: string | null },
  actor: Actor,
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const written = await dependencies.authority.mutate({
    kind: "file",
    ref: ref.value,
    path: input.path,
    content: input.content,
    expectedContentHash: input.expectedContentHash,
  }, actor);
  return written.ok
    ? ok({
        file: { path: input.path, content: input.content, contentHash: written.value.contentHash },
        revision: written.value.revision,
        diagnostics: written.value.diagnostics,
      })
    : written;
}

export async function patchPreviewSettings(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; patch: PreviewSettingsPatchDto; expectedRevision: number },
  actor: Actor,
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const written = await dependencies.authority.mutate({
    kind: "entity",
    ref: ref.value,
    entity: "preview-settings",
    patch: input.patch,
    expectedRevision: input.expectedRevision,
  }, actor);
  return written.ok
    ? ok({
        previewSettings: written.value.previewSettings!,
        revision: written.value.revision,
        diagnostics: written.value.diagnostics,
      })
    : written;
}

function safeAssetName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+/, "");
}

export async function uploadBgm(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; name: string; bytes: Uint8Array; expectedRevision: number },
  actor: Actor,
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const name = safeAssetName(input.name);
  if (!name) return err({ code: ErrorCode.NoFile, message: "uploaded BGM has no usable filename" });
  const path = `preview-assets/bgm/${name}` as RelPath;
  if (!dependencies.authority.uploadBgm) {
    return err({ code: ErrorCode.StorageUnavailable, message: "BGM upload is unavailable" });
  }
  const written = await dependencies.authority.uploadBgm({
    ref: ref.value,
    name,
    path,
    bytes: input.bytes,
    expectedRevision: input.expectedRevision,
  }, actor);
  return written.ok
    ? ok({ previewSettings: written.value.previewSettings!, revision: written.value.revision, diagnostics: written.value.diagnostics })
    : written;
}

async function sourceForMutation(
  dependencies: ProjectWriteDependencies,
  ref: ProjectRef,
  path: RelPath,
): Promise<Result<{ content: string; contentHash: ContentHash }, DomainError>> {
  const resolved = await dependencies.workspace.resolve(ref, path, "read-source");
  if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "composition path was rejected" });
  const file = await dependencies.workspace.readFile(resolved.value);
  return file ? ok(file) : err({ code: ErrorCode.NotFound, message: "composition file was not found" });
}

export async function setSceneTiming(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneId: string;
    timing: { start?: number; duration?: number; trackIndex?: number };
    expectedContentHash: string;
  },
  actor: Actor,
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const model = await dependencies.composition.parseProject(ref.value);
  const scene = (model.scenes as Array<{ id: string; start: number; duration: number; trackIndex: number }>)
    .find((candidate) => candidate.id === input.sceneId);
  if (!scene) return err({ code: ErrorCode.NotFound, message: "scene was not found" });
  const timingError = validateSceneTiming({
    start: input.timing.start ?? scene.start,
    duration: input.timing.duration ?? scene.duration,
    trackIndex: input.timing.trackIndex ?? scene.trackIndex,
    rootDuration: model.project.duration,
  });
  if (timingError) return err(timingError);
  const source = await sourceForMutation(dependencies, ref.value, ref.value.entry);
  if (!source.ok) return source;
  const applied = await dependencies.composition.applyOps(ref.value, ref.value.entry, [
    { kind: "setTiming", target: input.sceneId, value: input.timing },
  ]);
  if (!applied.ok) return applied;
  return saveSourceFile(dependencies, {
    projectId: input.projectId,
    path: ref.value.entry,
    content: applied.value,
    expectedContentHash: input.expectedContentHash,
  }, actor);
}

export async function setSceneScript(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneId: string;
    file: RelPath;
    elementId: string;
    text: string;
    expectedContentHash: string;
  },
  actor: Actor,
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const model = await dependencies.composition.parseProject(ref.value);
  const scene = (model.scenes as Array<{ id: string; script: Array<{ id: string; file: string }> }>)
    .find((candidate) => candidate.id === input.sceneId);
  if (!scene || !scene.script.some((line) => line.id === input.elementId && line.file === input.file)) {
    return err({ code: ErrorCode.NotFound, message: "script element does not belong to this scene" });
  }
  const source = await sourceForMutation(dependencies, ref.value, input.file);
  if (!source.ok) return source;
  const applied = await dependencies.composition.applyOps(ref.value, input.file, [
    { kind: "setText", target: input.elementId, value: input.text },
  ]);
  if (!applied.ok) return applied;
  return saveSourceFile(dependencies, {
    projectId: input.projectId,
    path: input.file,
    content: applied.value,
    expectedContentHash: input.expectedContentHash,
  }, actor);
}

export interface NarrationRecord {
  sceneId: string;
  text: string;
  voice: string;
  status: "mock";
  audioPath: string;
  command: string;
  revision: number;
  updatedAt: string;
}

export async function regenerateNarration(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; sceneId: string; text: string },
  actor: Actor,
): Promise<Result<NarrationRecord, DomainError>> {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const path = `narration/${input.sceneId}.json` as RelPath;
  const resolved = await dependencies.workspace.resolve(ref.value, path, "system-write");
  if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "narration path was rejected" });
  const previous = await dependencies.workspace.readFile(resolved.value);
  let previousRevision = 0;
  if (previous) {
    try { previousRevision = Number((JSON.parse(previous.content) as { revision?: unknown }).revision) || 0; } catch { /* reset */ }
  }
  const audioPath = `narration/${input.sceneId}.wav`;
  const narration: NarrationRecord = {
    sceneId: input.sceneId,
    text: input.text,
    voice: "af_heart",
    status: "mock",
    audioPath,
    command: `hyperframes tts --text "${input.text.replace(/"/g, '\\"')}" --voice af_heart -o ${audioPath}`,
    revision: previousRevision + 1,
    updatedAt: dependencies.clock.now().toISOString(),
  };
  const written = await dependencies.authority.mutate({
    kind: "file",
    ref: ref.value,
    path,
    content: `${JSON.stringify(narration, null, 2)}\n`,
    expectedContentHash: previous?.contentHash ?? null,
    purpose: "system-write",
  }, actor);
  return written.ok ? ok(narration) : written;
}

function sceneSource(sceneId: string, title: string, duration: number): string {
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="UTF-8" /></head><body><div id="${sceneId}" data-composition-id="${sceneId}" data-width="1920" data-height="1080" data-start="0" data-duration="${duration}"><h2>${escaped}</h2></div></body></html>\n`;
}

export async function createScene(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; title: string; duration?: number },
  actor: Actor,
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const [model, source] = await Promise.all([
    dependencies.composition.parseProject(ref.value),
    sourceForMutation(dependencies, ref.value, ref.value.entry),
  ]);
  if (!source.ok) return source;
  const scenes = model.scenes as Array<{ id: string; start: number; duration: number; trackIndex: number }>;
  const generated = scenes.flatMap((scene) => {
    const match = /^scene-(\d+)$/.exec(scene.id);
    return match ? [Number(match[1])] : [];
  });
  const sceneId = `scene-${generated.length ? Math.max(...generated) + 1 : 1}`;
  const start = Math.max(0, ...scenes.map((scene) => scene.start + scene.duration));
  const duration = input.duration ?? 4;
  const trackIndex = Math.max(0, ...scenes.map((scene) => scene.trackIndex)) + 1;
  const scenePath = `compositions/${sceneId}.html` as RelPath;
  const sceneWrite = await dependencies.authority.mutate({
    kind: "file",
    ref: ref.value,
    path: scenePath,
    content: sceneSource(sceneId, input.title, duration),
    expectedContentHash: null,
  }, actor);
  if (!sceneWrite.ok) return sceneWrite;
  const html = `<div id="${sceneId}-layer" class="comp-layer clip" data-composition-id="${sceneId}" data-composition-src="${scenePath}" data-start="${start}" data-duration="${duration}" data-track-index="${trackIndex}"></div>`;
  const applied = await dependencies.composition.applyOps(ref.value, ref.value.entry, [
    { kind: "addElement", target: "@root", value: { index: -1, html } },
    ...start + duration > model.project.duration
      ? [{ kind: "setTiming" as const, target: "@root", value: { duration: start + duration } }]
      : [],
  ]);
  if (!applied.ok) return applied;
  const entryWrite = await saveSourceFile(dependencies, {
    projectId: input.projectId,
    path: ref.value.entry,
    content: applied.value,
    expectedContentHash: source.value.contentHash,
  }, actor);
  if (!entryWrite.ok) return entryWrite;
  const narration = await regenerateNarration(dependencies, {
    projectId: input.projectId,
    sceneId,
    text: input.title,
  }, actor);
  return narration.ok ? ok({ sceneId, start, duration, narration: narration.value }) : narration;
}
