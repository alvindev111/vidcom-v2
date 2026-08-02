import {
  ErrorCode,
  MAX_SOURCE_BYTES,
  type Actor,
  type ContentHash,
  type DomainError,
  type PreviewSettingsPatchDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import { validateSceneTiming } from "../domain/invariants";
import { checkPathPurpose, checkPathSyntax } from "../domain/path-policy";
import { err, ok, type Result } from "../error/result";
import type { ClockPort, CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { WriteInvocation } from "../port/types";
import type { WriteAuthority } from "../service/write-authority";

export interface ProjectWriteDependencies {
  workspace: WorkspacePort;
  composition: CompositionPort;
  journal: MutationJournalPort;
  authority: Pick<WriteAuthority, "mutate" | "mutateComposite"> & Partial<Pick<WriteAuthority, "uploadBgm">>;
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
  invocation: WriteInvocation = { toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  if (new TextEncoder().encode(input.content).byteLength > MAX_SOURCE_BYTES) {
    return err({ code: ErrorCode.TooLarge, message: `source content exceeds ${MAX_SOURCE_BYTES} bytes` });
  }
  if (checkPathSyntax(input.path) || checkPathPurpose(input.path, "write-source")) {
    return err({ code: ErrorCode.AssetNotAllowed, message: "the path is not an allowed composition source" });
  }
  const written = await dependencies.authority.mutate({
    kind: "file",
    ref: ref.value,
    path: input.path,
    content: input.content,
    expectedContentHash: input.expectedContentHash,
  }, actor, invocation);
  return written.ok
    ? ok({
        file: { path: input.path, contentHash: written.value.contentHash },
        envelope: {
          projectRevision: written.value.revision,
          entityRevision: null,
          fileHashes: { [input.path]: written.value.contentHash },
          diagnostics: written.value.diagnostics,
        },
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
  invocation: WriteInvocation = { toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const model = await dependencies.composition.parseProject(ref.value);
  const scene = model.scenes.find((candidate) => candidate.id === input.sceneId);
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
  const written = await dependencies.authority.mutate({
    kind: "file",
    ref: ref.value,
    path: ref.value.entry,
    content: applied.value,
    expectedContentHash: input.expectedContentHash as ContentHash,
  }, actor, invocation);
  if (!written.ok) return written;
  const updatedScene = {
    ...scene,
    start: input.timing.start ?? scene.start,
    duration: input.timing.duration ?? scene.duration,
    trackIndex: input.timing.trackIndex ?? scene.trackIndex,
  };
  return ok({
    scene: {
      id: updatedScene.id,
      src: updatedScene.src,
      start: updatedScene.start,
      duration: updatedScene.duration,
      trackIndex: updatedScene.trackIndex,
      isTransition: updatedScene.isTransition,
      elementCount: updatedScene.elements.length,
      fileContentHash: written.value.contentHash,
      narrationStale: updatedScene.narration !== null && updatedScene.narration.staleSince !== null,
    },
    project: {
      ...model.project,
      updatedAt: dependencies.clock.now().toISOString(),
      revision: written.value.revision,
    },
    envelope: {
      projectRevision: written.value.revision,
      entityRevision: null,
      fileHashes: { [ref.value.entry]: written.value.contentHash },
      diagnostics: written.value.diagnostics,
    },
  });
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
  invocation: WriteInvocation = { toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const model = await dependencies.composition.parseProject(ref.value);
  const scene = model.scenes.find((candidate) => candidate.id === input.sceneId);
  if (!scene || !scene.script.some((line) => line.id === input.elementId && line.file === input.file)) {
    return err({ code: ErrorCode.NotFound, message: "script element does not belong to this scene" });
  }
  const source = await sourceForMutation(dependencies, ref.value, input.file);
  if (!source.ok) return source;
  const applied = await dependencies.composition.applyOps(ref.value, input.file, [
    { kind: "setText", target: input.elementId, value: input.text },
  ]);
  if (!applied.ok) return applied;
  const steps: Parameters<WriteAuthority["mutateComposite"]>[0]["steps"] = [{
    kind: "write",
    path: input.file,
    content: applied.value,
    expectedContentHash: input.expectedContentHash as ContentHash,
  }];
  const staleSince = dependencies.clock.now().toISOString();
  if (scene.narration !== null) {
    const narrationPath = `narration/${scene.id}.json` as RelPath;
    const resolved = await dependencies.workspace.resolve(ref.value, narrationPath, "system-write");
    if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "narration path was rejected" });
    const current = await dependencies.workspace.readFile(resolved.value);
    if (!current) return err({ code: ErrorCode.StorageUnavailable, message: "narration sidecar is missing" });
    let narration: Record<string, unknown>;
    try { narration = JSON.parse(current.content) as Record<string, unknown>; }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "narration sidecar is invalid" }); }
    steps.push({
      kind: "write",
      path: narrationPath,
      content: `${JSON.stringify({ ...narration, staleSince }, null, 2)}\n`,
      expectedContentHash: current.contentHash,
      purpose: "system-write",
    });
  }
  const written = await dependencies.authority.mutateComposite({
    ref: ref.value,
    steps,
    toolAudit: invocation.toolAudit,
    backup: false,
  }, actor);
  if (!written.ok) return written;
  return ok({
    scene: {
      id: scene.id,
      src: scene.src,
      start: scene.start,
      duration: scene.duration,
      trackIndex: scene.trackIndex,
      isTransition: scene.isTransition,
      elementCount: scene.elements.length,
      fileContentHash: written.value.fileHashes[input.file],
      narrationStale: true,
    },
    project: {
      ...model.project,
      updatedAt: staleSince,
      revision: written.value.projectRevision,
    },
    envelope: written.value,
    narrationStale: true as const,
  });
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
  staleSince: string | null;
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
    staleSince: null,
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
  return `<!doctype html><html><head><meta charset="UTF-8" /><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif}#${sceneId}{display:grid;place-items:center;width:1920px;height:1080px}h2{max-width:1400px;margin:0;padding:96px;text-align:center;font-size:96px;line-height:1.1}</style></head><body><div id="${sceneId}" data-composition-id="${sceneId}" data-width="1920" data-height="1080" data-start="0" data-duration="${duration}"><h2>${escaped}</h2></div></body></html>\n`;
}

export async function createScene(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; title: string; duration?: number; expectedContentHash: ContentHash },
  actor: Actor,
  invocation: WriteInvocation = { toolAudit: null },
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
  const html = `<div id="${sceneId}-layer" class="comp-layer clip" data-composition-id="${sceneId}" data-composition-src="${scenePath}" data-start="${start}" data-duration="${duration}" data-track-index="${trackIndex}"></div>`;
  const applied = await dependencies.composition.applyOps(ref.value, ref.value.entry, [
    { kind: "addElement", target: "@root", value: { index: -1, html } },
    ...start + duration > model.project.duration
      ? [{ kind: "setTiming" as const, target: "@root", value: { duration: start + duration } }]
      : [],
  ]);
  if (!applied.ok) return applied;
  const audioPath = `narration/${sceneId}.wav`;
  const narration: NarrationRecord = {
    sceneId,
    text: input.title,
    voice: "af_heart",
    status: "mock",
    audioPath,
    command: `hyperframes tts --text "${input.title.replace(/"/g, '\\"')}" --voice af_heart -o ${audioPath}`,
    revision: 1,
    updatedAt: dependencies.clock.now().toISOString(),
    staleSince: null,
  };
  const narrationPath = `narration/${sceneId}.json` as RelPath;
  const written = await dependencies.authority.mutateComposite({
    ref: ref.value,
    steps: [
      {
        kind: "write",
        path: scenePath,
        content: sceneSource(sceneId, input.title, duration),
        expectedContentHash: null,
      },
      {
        kind: "write",
        path: ref.value.entry,
        content: applied.value,
        expectedContentHash: input.expectedContentHash,
      },
      {
        kind: "write",
        path: narrationPath,
        content: `${JSON.stringify(narration, null, 2)}\n`,
        expectedContentHash: null,
        purpose: "system-write",
      },
    ],
    toolAudit: invocation.toolAudit,
    backup: false,
  }, actor);
  if (!written.ok) return written;
  const projectDuration = Math.max(model.project.duration, start + duration);
  return ok({
    scene: {
      id: sceneId,
      src: scenePath,
      start,
      duration,
      trackIndex,
      isTransition: false,
      elementCount: 1,
      fileContentHash: written.value.fileHashes[scenePath],
      narrationStale: false,
    },
    project: {
      ...model.project,
      duration: projectDuration,
      updatedAt: dependencies.clock.now().toISOString(),
      sceneCount: model.project.sceneCount + 1,
      revision: written.value.projectRevision,
    },
    envelope: written.value,
  });
}
