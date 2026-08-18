import {
  ErrorCode,
  MAX_PROJECT_DURATION_SECONDS,
  MAX_SOURCE_BYTES,
  type Actor,
  type ContentHash,
  type DomainError,
  type PreviewSettingsPatchDto,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import { detectTrackGapsAndOverlaps, planRipple, validateSceneTiming, type SceneClip } from "../domain/invariants";
import { planSceneInsertion } from "../domain/plan-scene-order";
import { checkPathPurpose, checkPathSyntax } from "../domain/path-policy";
import { rootCompositionSource } from "../domain/platform-preset";
import { err, ok, type Result } from "../error/result";
import { ignoredMutationOriginForActor, type UndoContentPort } from "../port/mutation-observer";
import type { ClockPort, CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { CompositeRequest, WriteInvocation } from "../port/types";
import type { WriteAuthority } from "../service/write-authority";
import { readCues, type NarrationCue } from "./narration-cues";
import type { ProjectIdentityService } from "./project-identity";

export interface ProjectWriteDependencies {
  workspace: WorkspacePort;
  composition: CompositionPort;
  journal: MutationJournalPort;
  authority: Pick<WriteAuthority, "mutateSource"> & Partial<Pick<WriteAuthority, "uploadBgm">>;
  clock: ClockPort;
  /** Live content resolver required only by applyMutationInverse. */
  undoContent?: UndoContentPort;
  identity?: Pick<ProjectIdentityService, "read">;
}

async function findRef(dependencies: ProjectWriteDependencies, id: ProjectId): Promise<Result<ProjectRef, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(id);
  return ref ? ok(ref) : err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
}

async function parseForMutation(dependencies: ProjectWriteDependencies, ref: ProjectRef) {
  try {
    const source = await sourceForMutation(dependencies, ref, ref.entry);
    if (!source.ok) return err({
      code: ErrorCode.ProjectInvalid,
      message: "project composition is invalid",
      details: { reason: ErrorCode.CompositionParseError },
    });
    if (dependencies.composition.validateSource) {
      const valid = await dependencies.composition.validateSource(ref.entry, source.value.content);
      if (!valid.ok) return err({
        code: ErrorCode.ProjectInvalid,
        message: "project composition is invalid",
        details: { reason: ErrorCode.CompositionParseError },
      });
    }
    return ok(await dependencies.composition.parseProject(ref));
  } catch {
    return err({
      code: ErrorCode.ProjectInvalid,
      message: "project composition is invalid",
      details: { reason: ErrorCode.CompositionParseError },
    });
  }
}

export async function saveSourceFile(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; path: RelPath; content: string; expectedContentHash: string | null },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  if (new TextEncoder().encode(input.content).byteLength > MAX_SOURCE_BYTES) {
    return err({ code: ErrorCode.TooLarge, message: `source content exceeds ${MAX_SOURCE_BYTES} bytes` });
  }
  if (checkPathSyntax(input.path) || checkPathPurpose(input.path, "write-source")) {
    return err({ code: ErrorCode.AssetNotAllowed, message: "the path is not an allowed composition source" });
  }
  const written = await dependencies.authority.mutateSource({
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
          changeSeq: written.value.changeSeq ?? null,
        },
      })
    : written;
}

export async function patchPreviewSettings(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; patch: PreviewSettingsPatchDto; expectedRevision: number },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const written = await dependencies.authority.mutateSource({
    kind: "entity",
    ref: ref.value,
    entity: "preview-settings",
    patch: input.patch,
    expectedRevision: input.expectedRevision,
  }, actor, invocation);
  return written.ok
    ? ok({
        previewSettings: written.value.previewSettings!,
        revision: written.value.revision,
        diagnostics: written.value.diagnostics,
        changeSeq: written.value.changeSeq ?? null,
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
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
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
  }, actor, invocation);
  return written.ok
    ? ok({
        previewSettings: written.value.previewSettings!,
        revision: written.value.revision,
        diagnostics: written.value.diagnostics,
        changeSeq: written.value.changeSeq ?? null,
      })
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
    ripple?: boolean;
    extendRoot?: boolean;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  if (input.timing.start === undefined
    && input.timing.duration === undefined
    && input.timing.trackIndex === undefined) {
    return err({ code: ErrorCode.SchemaInvalid, message: "at least one scene timing field is required", field: "timing" });
  }
  const parsed = await parseForMutation(dependencies, ref.value);
  if (!parsed.ok) return parsed;
  const model = parsed.value;
  const scene = model.scenes.find((candidate) => candidate.id === input.sceneId);
  if (!scene) return err({ code: ErrorCode.NotFound, message: "scene was not found" });
  const next = {
    sceneId: scene.id,
    start: input.timing.start ?? scene.start,
    duration: input.timing.duration ?? scene.duration,
    trackIndex: input.timing.trackIndex ?? scene.trackIndex,
  };
  const timingError = validateSceneTiming({ ...next, rootDuration: Number.POSITIVE_INFINITY });
  if (timingError) return err(timingError);
  if (input.ripple && next.trackIndex !== scene.trackIndex) {
    return err({ code: ErrorCode.TimingInvalid, message: "ripple cannot move a scene between tracks", field: "trackIndex" });
  }
  const clips: SceneClip[] = model.scenes.map((item) => ({
    sceneId: item.id, start: item.start, duration: item.duration, trackIndex: item.trackIndex,
  }));
  const ripple = input.ripple
    ? planRipple(clips, { sceneId: scene.id, start: next.start, duration: next.duration })
    : null;
  if (ripple && !ripple.ok) return ripple;
  const moved = ripple?.ok ? ripple.value.moved : [];
  const changed = new Map(moved.map((item) => [item.sceneId, item.toStart]));
  changed.set(scene.id, next.start);
  const nextClips = clips.map((item) => item.sceneId === scene.id
    ? next
    : changed.has(item.sceneId) ? { ...item, start: changed.get(item.sceneId)! } : item);
  const rootDuration = nextClips.reduce((maximum, item) => Math.max(maximum, item.start + item.duration), 0);
  if (rootDuration > MAX_PROJECT_DURATION_SECONDS) return err({
    code: ErrorCode.DurationOverflow,
    message: "project duration exceeds the VidCom runtime guard",
    field: "duration",
    details: {
      limitKind: "runtime", actualSeconds: rootDuration,
      maxSeconds: MAX_PROJECT_DURATION_SECONDS, extendRootAllowed: false,
    },
  });
  if (rootDuration > model.project.duration && !input.extendRoot) return err({
    code: ErrorCode.DurationOverflow,
    message: "scene timing exceeds the current root duration",
    field: "duration",
    details: {
      limitKind: "root", actualSeconds: rootDuration,
      maxSeconds: model.project.duration, extendRootAllowed: true,
    },
  });
  const source = await sourceForMutation(dependencies, ref.value, ref.value.entry);
  if (!source.ok) return source;
  const operations = [
    { kind: "setTiming" as const, target: input.sceneId, value: input.timing },
    ...moved.filter(({ sceneId }) => sceneId !== input.sceneId).map((item) => ({
      kind: "setTiming" as const, target: item.sceneId, value: { start: item.toStart },
    })),
    ...(rootDuration !== model.project.duration
      ? [{ kind: "setTiming" as const, target: "@root", value: { duration: rootDuration } }]
      : []),
  ];
  const applied = await dependencies.composition.applyOps(ref.value, ref.value.entry, operations);
  if (!applied.ok) return applied;
  const written = await dependencies.authority.mutateSource({
    kind: "file",
    ref: ref.value,
    path: ref.value.entry,
    content: applied.value,
    expectedContentHash: input.expectedContentHash as ContentHash,
  }, actor, invocation);
  if (!written.ok) return written;
  const updatedScene = {
    ...scene,
    start: next.start,
    duration: next.duration,
    trackIndex: next.trackIndex,
  };
  const diagnostics = input.ripple ? [] : detectTrackGapsAndOverlaps(
    nextClips.filter((item) => item.trackIndex === next.trackIndex),
  );
  const identity = await dependencies.identity?.read(ref.value.root);
  const recommended = identity?.ok ? identity.identity.platform?.recommendedMaxDurationSeconds : null;
  if (recommended !== null && recommended !== undefined && rootDuration > recommended) diagnostics.push({
    severity: "warning",
    code: "platform-duration-recommendation",
    sceneId: scene.id,
    message: `Project duration ${rootDuration}s exceeds the platform recommendation of ${recommended}s.`,
  });
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
      diagnostics: [...written.value.diagnostics, ...diagnostics],
      changeSeq: written.value.changeSeq ?? null,
    },
    affectedTrackIndex: next.trackIndex,
    moved,
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
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const parsed = await parseForMutation(dependencies, ref.value);
  if (!parsed.ok) return parsed;
  const model = parsed.value;
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
  const steps: CompositeRequest["steps"] = [{
    kind: "write",
    path: input.file,
    content: applied.value,
    expectedContentHash: input.expectedContentHash as ContentHash,
  }];
  const staleSince = dependencies.clock.now().toISOString();
  let narrationStale = false;
  if (scene.narration !== null) {
    const narrationPath = `narration/${scene.id}.json` as RelPath;
    const resolved = await dependencies.workspace.resolve(ref.value, narrationPath, "system-write");
    if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "narration path was rejected" });
    const current = await dependencies.workspace.readFile(resolved.value);
    if (!current) return err({ code: ErrorCode.StorageUnavailable, message: "narration sidecar is missing" });
    let narration: Record<string, unknown>;
    try { narration = JSON.parse(current.content) as Record<string, unknown>; }
    catch { return err({ code: ErrorCode.StorageUnavailable, message: "narration sidecar is invalid" }); }
    const parsedCues = readCues(narration);
    const legacyStatus: NarrationCue["status"] = narration.status === "mock" || narration.status === "generated"
      ? narration.status : undefined;
    const cues: NarrationCue[] = Array.isArray(narration.cues) ? parsedCues : parsedCues.map((cue): NarrationCue => ({
      ...cue,
      ...(legacyStatus ? { status: legacyStatus } : {}),
      ...(typeof narration.audioPath === "string" ? { audioPath: narration.audioPath } : {}),
      ...(typeof narration.command === "string" ? { command: narration.command } : {}),
    }));
    const target = cues.findIndex((cue) => cue.cueId === input.elementId);
    const cueIndex = target >= 0 ? target : cues.length === 1 ? 0 : -1;
    if (cueIndex >= 0) {
      narrationStale = true;
      const nextCues = cues.map((cue, index) => index === cueIndex ? { ...cue, staleSince } : cue);
      steps.push({
        kind: "write",
        path: narrationPath,
        content: serializeNarrationSidecar(
          scene.id,
          nextCues,
          (typeof narration.revision === "number" ? narration.revision : 0) + 1,
          staleSince,
        ),
        expectedContentHash: current.contentHash,
      });
    }
  }
  const written = await dependencies.authority.mutateSource({
    ref: ref.value,
    steps,
    ...invocation,
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
      narrationStale,
    },
    project: {
      ...model.project,
      updatedAt: staleSince,
      revision: written.value.projectRevision,
    },
    envelope: written.value,
    narrationStale,
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
  changeSeq: number | null;
}

interface NarrationSidecarV2 {
  schemaVersion: 2;
  sceneId: string;
  cues: NarrationCue[];
  revision: number;
  updatedAt: string;
  /** First-cue compatibility projection for existing Studio/read clients. */
  text?: string;
  voice?: string;
  status?: "mock" | "generated";
  audioPath?: string;
  command?: string;
  staleSince?: string | null;
  durationSeconds?: number;
  provider?: string;
  words?: NarrationCue["words"];
  wordTimingSource?: NarrationCue["wordTimingSource"];
  engine?: NarrationCue["engine"];
}

function cueAudioPath(sceneId: string, cueId: string): string {
  return `narration/${sceneId}/${cueId}.wav`;
}

function initialCue(sceneId: string, text: string, cueId = sceneId): NarrationCue {
  const audioPath = cueAudioPath(sceneId, cueId);
  return {
    cueId,
    text,
    voice: "af_heart",
    offsetSeconds: 0,
    durationSeconds: null,
    staleSince: null,
    status: "mock",
    audioPath,
    command: `hyperframes tts --text "${text.replace(/"/g, '\\"')}" --voice af_heart -o ${audioPath}`,
  };
}

function serializeNarrationSidecar(
  sceneId: string,
  cues: NarrationCue[],
  revision: number,
  updatedAt: string,
): string {
  const first = cues[0];
  const sidecar: NarrationSidecarV2 = {
    schemaVersion: 2, sceneId, cues, revision, updatedAt,
    ...(first ? {
      text: first.text,
      voice: first.voice,
      ...(first.status ? { status: first.status } : {}),
      ...(first.audioPath ? { audioPath: first.audioPath } : {}),
      ...(first.command ? { command: first.command } : {}),
      ...(first.provider ? { provider: first.provider } : {}),
      staleSince: first.staleSince,
      ...(first.durationSeconds ? { durationSeconds: first.durationSeconds } : {}),
      ...(first.words ? { words: first.words } : {}),
      ...(first.wordTimingSource ? { wordTimingSource: first.wordTimingSource } : {}),
      ...(first.engine ? { engine: first.engine } : {}),
    } : {}),
  };
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

export async function regenerateNarration(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneId: string;
    text: string;
    cueId?: string;
    offsetSeconds?: number;
    voice?: string;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
): Promise<Result<NarrationRecord, DomainError>> {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const path = `narration/${input.sceneId}.json` as RelPath;
  const resolved = await dependencies.workspace.resolve(ref.value, path, "system-write");
  if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "narration path was rejected" });
  const previous = await dependencies.workspace.readFile(resolved.value);
  let previousRevision = 0;
  let cues: NarrationCue[] = [];
  if (previous) {
    try {
      const parsed = JSON.parse(previous.content) as { revision?: unknown };
      previousRevision = Number(parsed.revision) || 0;
      cues = readCues(parsed);
    } catch { /* reset */ }
  }
  const cueId = input.cueId ?? cues[0]?.cueId ?? input.sceneId;
  const current = cues.find((cue) => cue.cueId === cueId);
  const audioPath = current?.audioPath ?? cueAudioPath(input.sceneId, cueId);
  const voice = input.voice ?? current?.voice ?? "af_heart";
  const cue: NarrationCue = {
    ...(current ?? initialCue(input.sceneId, input.text, cueId)),
    cueId,
    text: input.text,
    voice,
    offsetSeconds: input.offsetSeconds ?? current?.offsetSeconds ?? 0,
    durationSeconds: null,
    staleSince: null,
    status: "mock",
    audioPath,
    command: `hyperframes tts --text "${input.text.replace(/"/g, '\\"')}" --voice ${voice} -o ${audioPath}`,
  };
  const nextCues = current
    ? cues.map((candidate) => candidate.cueId === cueId ? cue : candidate)
    : [...cues, cue];
  const narration: Omit<NarrationRecord, "changeSeq"> = {
    sceneId: input.sceneId,
    text: input.text,
    voice,
    status: "mock",
    audioPath,
    command: cue.command!,
    revision: previousRevision + 1,
    updatedAt: dependencies.clock.now().toISOString(),
    staleSince: null,
  };
  const written = await dependencies.authority.mutateSource({
    kind: "file",
    ref: ref.value,
    path,
    content: serializeNarrationSidecar(
      input.sceneId,
      nextCues,
      previousRevision + 1,
      narration.updatedAt,
    ),
    expectedContentHash: previous?.contentHash ?? null,
  }, actor, invocation);
  return written.ok ? ok({ ...narration, changeSeq: written.value.changeSeq ?? null }) : written;
}

function sceneSource(
  sceneId: string,
  title: string,
  duration: number,
  dimensions: { width: number; height: number },
): string {
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="UTF-8" /></head><body><template><style>#${sceneId}{display:grid;place-items:center;width:${dimensions.width}px;height:${dimensions.height}px;overflow:hidden;box-sizing:border-box;background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif}#${sceneId} h2{max-width:80%;margin:0;padding:8%;text-align:center;font-size:clamp(48px,5vw,96px);line-height:1.1}</style><div id="${sceneId}" data-composition-id="${sceneId}" data-width="${dimensions.width}" data-height="${dimensions.height}" data-start="0" data-duration="${duration}"><h2>${escaped}</h2></div></template></body></html>\n`;
}

function sceneMount(
  sceneId: string,
  scenePath: RelPath,
  timing: { start: number; duration: number; trackIndex: number },
  dimensions: { width: number; height: number },
): string {
  return `<div id="${sceneId}-layer" class="comp-layer clip" data-composition-id="${sceneId}" data-composition-src="${scenePath}" data-start="${timing.start}" data-duration="${timing.duration}" data-track-index="${timing.trackIndex}" data-width="${dimensions.width}" data-height="${dimensions.height}"></div>`;
}

export async function createScene(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    title: string;
    duration?: number;
    index?: number;
    trackIndex?: number;
    expectedContentHash: ContentHash | null;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const resolvedEntry = await dependencies.workspace.resolve(ref.value, ref.value.entry, "read-source");
  if (!resolvedEntry.ok) return err({ code: ErrorCode.PathOutsideProject, message: "composition path was rejected" });
  const existingEntry = await dependencies.workspace.readFile(resolvedEntry.value);
  if ((existingEntry?.contentHash ?? null) !== input.expectedContentHash) {
    return err({ code: ErrorCode.WriteConflict, message: "composition changed before scene insertion" });
  }
  const duration = input.duration ?? 4;
  const basicTiming = validateSceneTiming({
    start: 0, duration, trackIndex: input.trackIndex ?? 0, rootDuration: Number.POSITIVE_INFINITY,
  });
  if (basicTiming) return err(basicTiming);

  if (!existingEntry) {
    if (input.index !== undefined && input.index !== 0) {
      return err({ code: ErrorCode.SchemaInvalid, message: "the first scene index must be zero", field: "index" });
    }
    const identity = await dependencies.identity?.read(ref.value.root);
    if (!identity?.ok || !identity.identity.platform) {
      return err({ code: ErrorCode.ProjectInvalid, message: "empty project platform is unavailable" });
    }
    const trackIndex = input.trackIndex ?? 0;
    const sceneId = "scene-1";
    const scenePath = `compositions/${sceneId}.html` as RelPath;
    const dimensions = identity.identity.platform;
    const mount = sceneMount(sceneId, scenePath, { start: 0, duration, trackIndex }, dimensions);
    const cue = initialCue(sceneId, input.title);
    const written = await dependencies.authority.mutateSource({
      ref: ref.value,
      steps: [
        {
          kind: "write",
          path: scenePath,
          content: sceneSource(sceneId, input.title, duration, dimensions),
          expectedContentHash: null,
        },
        {
          kind: "write", path: ref.value.entry,
          content: rootCompositionSource(identity.identity.platform, mount, duration), expectedContentHash: null,
        },
        {
          kind: "write", path: `narration/${sceneId}.json` as RelPath,
          content: serializeNarrationSidecar(sceneId, [cue], 1, dependencies.clock.now().toISOString()),
          expectedContentHash: null,
        },
      ],
      ...invocation,
      backup: false,
    }, actor);
    if (!written.ok) return written;
    return ok({
      scene: {
        id: sceneId, src: scenePath, start: 0, duration, trackIndex,
        isTransition: false, elementCount: 1,
        fileContentHash: written.value.fileHashes[scenePath], narrationStale: false,
      },
      project: {
        id: input.projectId, slug: ref.value.slug, title: ref.value.slug,
        width: identity.identity.platform.width, height: identity.identity.platform.height,
        duration, updatedAt: dependencies.clock.now().toISOString(), sceneCount: 1,
        revision: written.value.projectRevision,
      },
      envelope: written.value,
      affectedTrackIndex: trackIndex,
      moved: [] as Array<{ sceneId: string; fromStart: number; toStart: number }>,
    });
  }

  const parsed = await parseForMutation(dependencies, ref.value);
  if (!parsed.ok) return parsed;
  const model = parsed.value;
  const scenes = model.scenes as Array<{ id: string; start: number; duration: number; trackIndex: number }>;
  const generated = scenes.flatMap((scene) => {
    const match = /^scene-(\d+)$/.exec(scene.id);
    return match ? [Number(match[1])] : [];
  });
  const sceneId = `scene-${generated.length ? Math.max(...generated) + 1 : 1}`;
  const reference = input.index === undefined
    ? model.scenes[model.scenes.length - 1] ?? null
    : model.scenes[input.index] ?? null;
  const trackIndex = input.trackIndex ?? reference?.trackIndex ?? 0;
  const scenePath = `compositions/${sceneId}.html` as RelPath;
  const insertion = planSceneInsertion(
    scenes.map((scene) => ({
      sceneId: scene.id,
      start: scene.start,
      duration: scene.duration,
      trackIndex: scene.trackIndex,
    })),
    {
      sceneId,
      scenePath,
      duration,
      toIndex: input.index ?? scenes.filter((scene) => scene.trackIndex === trackIndex).length,
      trackIndex,
      rootDuration: model.project.duration,
    },
  );
  if (!insertion.ok) return insertion;
  if (insertion.value.rootDuration > MAX_PROJECT_DURATION_SECONDS) return err({
    code: ErrorCode.DurationOverflow,
    message: "project duration exceeds the VidCom runtime guard",
    field: "duration",
    details: {
      limitKind: "runtime", actualSeconds: insertion.value.rootDuration,
      maxSeconds: MAX_PROJECT_DURATION_SECONDS, extendRootAllowed: false,
    },
  });
  const dimensions = { width: model.project.width, height: model.project.height };
  const html = sceneMount(sceneId, scenePath, insertion.value.scene, dimensions);
  const documentIndex = insertion.value.beforeSceneId
    ? model.scenes.findIndex((scene) => scene.id === insertion.value.beforeSceneId)
    : -1;
  const applied = await dependencies.composition.applyOps(ref.value, ref.value.entry, [
    { kind: "addElement", target: "@root", value: { index: documentIndex, html } },
    ...insertion.value.changes.map((item) => ({
      kind: "setTiming" as const, target: item.sceneId, value: { start: item.start },
    })),
    ...insertion.value.rootDuration !== model.project.duration
      ? [{ kind: "setTiming" as const, target: "@root", value: { duration: insertion.value.rootDuration } }]
      : [],
  ]);
  if (!applied.ok) return applied;
  const cue = initialCue(sceneId, input.title);
  const narrationPath = `narration/${sceneId}.json` as RelPath;
  const written = await dependencies.authority.mutateSource({
    ref: ref.value,
    steps: [
      {
        kind: "write",
        path: scenePath,
        content: sceneSource(sceneId, input.title, duration, dimensions),
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
        content: serializeNarrationSidecar(sceneId, [cue], 1, dependencies.clock.now().toISOString()),
        expectedContentHash: null,
      },
    ],
    ...invocation,
    backup: false,
  }, actor);
  if (!written.ok) return written;
  return ok({
    scene: {
      id: sceneId,
      src: scenePath,
      start: insertion.value.scene.start,
      duration,
      trackIndex,
      isTransition: false,
      elementCount: 1,
      fileContentHash: written.value.fileHashes[scenePath],
      narrationStale: false,
    },
    project: {
      ...model.project,
      id: input.projectId,
      duration: insertion.value.rootDuration,
      updatedAt: dependencies.clock.now().toISOString(),
      sceneCount: model.project.sceneCount + 1,
      revision: written.value.projectRevision,
    },
    envelope: written.value,
    affectedTrackIndex: trackIndex,
    moved: insertion.value.changes.map((change) => {
      const previous = scenes.find((scene) => scene.id === change.sceneId)!;
      return { sceneId: change.sceneId, fromStart: previous.start, toStart: change.start! };
    }),
  });
}

export async function readNarrationCues(
  dependencies: Pick<ProjectWriteDependencies, "workspace">,
  input: { projectId: ProjectId; sceneId: string },
): Promise<Result<{ cues: NarrationCue[]; contentHash: ContentHash | null }, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const path = `narration/${input.sceneId}.json` as RelPath;
  const resolved = await dependencies.workspace.resolve(ref, path, "read-asset");
  if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "narration path was rejected" });
  const file = await dependencies.workspace.readFile(resolved.value);
  if (!file) return ok({ cues: [], contentHash: null });
  try {
    return ok({ cues: readCues(JSON.parse(file.content)), contentHash: file.contentHash });
  } catch {
    return err({ code: ErrorCode.ProjectInvalid, message: "narration sidecar could not be parsed" });
  }
}

async function persistNarrationCues(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneId: string;
    cues: NarrationCue[];
    expectedContentHash: ContentHash | null;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const ref = await findRef(dependencies, input.projectId);
  if (!ref.ok) return ref;
  const path = `narration/${input.sceneId}.json` as RelPath;
  const resolved = await dependencies.workspace.resolve(ref.value, path, "system-write");
  if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "narration path was rejected" });
  const current = await dependencies.workspace.readFile(resolved.value);
  if ((current?.contentHash ?? null) !== input.expectedContentHash) {
    return err({ code: ErrorCode.WriteConflict, message: "narration changed before cue replacement" });
  }
  const ids = input.cues.map(({ cueId }) => cueId);
  if (new Set(ids).size !== ids.length) return err({
    code: ErrorCode.SchemaInvalid, message: "narration cue ids must be unique", field: "cues",
  });
  let revision = 0;
  if (current) {
    try { revision = Number((JSON.parse(current.content) as { revision?: unknown }).revision) || 0; }
    catch { return err({ code: ErrorCode.ProjectInvalid, message: "narration sidecar could not be parsed" }); }
  }
  const cues = input.cues;
  const written = await dependencies.authority.mutateSource({
    kind: "file",
    ref: ref.value,
    path,
    content: serializeNarrationSidecar(input.sceneId, cues, revision + 1, dependencies.clock.now().toISOString()),
    expectedContentHash: input.expectedContentHash,
  }, actor, invocation);
  return written.ok ? ok({ cues, contentHash: written.value.contentHash, revision: written.value.revision }) : written;
}

/** Replaces authored cues and deliberately resets synthesis metadata for the new cue set. */
export function replaceNarrationCues(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneId: string;
    cues: Array<Pick<NarrationCue, "cueId" | "text" | "voice" | "offsetSeconds">>;
    expectedContentHash: ContentHash | null;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  return persistNarrationCues(dependencies, {
    ...input,
    cues: input.cues.map((cue) => ({
      ...initialCue(input.sceneId, cue.text, cue.cueId),
      voice: cue.voice,
      offsetSeconds: cue.offsetSeconds,
    })),
  }, actor, invocation);
}

/** Updates one narration cue without rebuilding metadata for it or its siblings. */
export async function patchNarrationCue(
  dependencies: ProjectWriteDependencies,
  input: {
    projectId: ProjectId;
    sceneId: string;
    cueId: string;
    patch: Partial<Pick<NarrationCue, "text" | "voice" | "offsetSeconds">>;
    expectedContentHash: ContentHash;
  },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
) {
  const current = await readNarrationCues(dependencies, input);
  if (!current.ok) return current;
  if (current.value.contentHash !== input.expectedContentHash) return err({
    code: ErrorCode.WriteConflict, message: "narration changed before cue update",
  });
  const cue = current.value.cues.find((candidate) => candidate.cueId === input.cueId);
  if (!cue) return err({ code: ErrorCode.NotFound, message: "narration cue was not found" });
  const contentChanged = (input.patch.text !== undefined && input.patch.text !== cue.text)
    || (input.patch.voice !== undefined && input.patch.voice !== cue.voice);
  const staleSince = contentChanged ? dependencies.clock.now().toISOString() : cue.staleSince;
  return persistNarrationCues(dependencies, {
    projectId: input.projectId,
    sceneId: input.sceneId,
    cues: current.value.cues.map((candidate) => candidate.cueId === input.cueId ? {
      ...candidate,
      text: input.patch.text ?? candidate.text,
      voice: input.patch.voice ?? candidate.voice,
      offsetSeconds: input.patch.offsetSeconds ?? candidate.offsetSeconds,
      staleSince,
    } : candidate),
    expectedContentHash: input.expectedContentHash,
  }, actor, invocation);
}
