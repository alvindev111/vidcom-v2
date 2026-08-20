import {
  ErrorCode,
  MAX_PROJECT_DURATION_SECONDS,
  type Actor,
  type ContentHash,
  type Diagnostic,
  type DomainError,
  type ProjectId,
} from "@vidcom/contracts";

import { FrameGrid } from "../domain/frame-grid";
import { detectTrackGapsAndOverlaps, type SceneClip } from "../domain/invariants";
import type { CompositionModel, ProjectRef } from "../domain/models";
import type { ReorderPlan } from "../domain/plan-scene-order";
import { err, ok, type Result } from "../error/result";
import type { WriteEnvelope, WriteInvocation } from "../port/types";
import type { ProjectWriteDependencies } from "./project-writes";

export interface SceneOrderInput {
  projectId: ProjectId;
  expectedContentHash: string;
  extendRoot?: boolean;
}

export interface SceneOrderContext {
  ref: ProjectRef;
  model: CompositionModel;
  clips: SceneClip[];
  contentHash: ContentHash;
  frameGrid: FrameGrid;
}

export async function loadSceneOrderContext(
  dependencies: ProjectWriteDependencies,
  input: SceneOrderInput,
): Promise<Result<SceneOrderContext, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const resolved = await dependencies.workspace.resolve(ref, ref.entry, "read-source");
  if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "composition path was rejected" });
  const source = await dependencies.workspace.readFile(resolved.value);
  if (!source) return err({ code: ErrorCode.NotFound, message: "composition file was not found" });
  if (source.contentHash !== input.expectedContentHash) {
    return err({
      code: ErrorCode.WriteConflict,
      message: "composition changed before scene order mutation",
      details: { currentContentHash: source.contentHash },
    });
  }
  if (dependencies.composition.validateSource) {
    const valid = await dependencies.composition.validateSource(ref.entry, source.content);
    if (!valid.ok) {
      return err({
        code: ErrorCode.ProjectInvalid,
        message: "project composition is invalid",
        details: { reason: ErrorCode.CompositionParseError },
      });
    }
  }
  let model: CompositionModel;
  try { model = await dependencies.composition.parseProject(ref); }
  catch {
    return err({
      code: ErrorCode.ProjectInvalid,
      message: "project composition is invalid",
      details: { reason: ErrorCode.CompositionParseError },
    });
  }
  return ok({
    ref,
    model,
    clips: model.scenes.map((scene) => ({
      sceneId: scene.id,
      start: scene.start,
      duration: scene.duration,
      trackIndex: scene.trackIndex,
    })),
    contentHash: source.contentHash,
    frameGrid: FrameGrid.fromFps(model.frameRate ?? 30),
  });
}

export async function applySceneOrderPlan(
  dependencies: ProjectWriteDependencies,
  context: SceneOrderContext,
  plan: ReorderPlan,
  input: SceneOrderInput,
  actor: Actor,
  invocation: WriteInvocation,
): Promise<Result<{
  changed: boolean;
  project: CompositionModel["project"];
  envelope: WriteEnvelope | null;
  changes: ReorderPlan["changes"];
  diagnostics: Diagnostic[];
}, DomainError>> {
  if (plan.noOp) {
    invocation.noteUnchanged?.();
    return ok({ changed: false, project: context.model.project, envelope: null, changes: [], diagnostics: [] });
  }
  for (const change of plan.changes) {
    if (change.start === undefined) continue;
    const alignment = context.frameGrid.validate(change.start, "start");
    if (alignment) return err(alignment);
  }
  if (plan.rootDuration !== context.model.project.duration) {
    const alignment = context.frameGrid.validate(plan.rootDuration, "duration");
    if (alignment) return err(alignment);
  }
  if (plan.rootDuration > MAX_PROJECT_DURATION_SECONDS) {
    return err({
      code: ErrorCode.DurationOverflow,
      message: "project duration exceeds the VidCom runtime guard",
      field: "duration",
      details: {
        limitKind: "runtime",
        actualSeconds: plan.rootDuration,
        maxSeconds: MAX_PROJECT_DURATION_SECONDS,
        extendRootAllowed: false,
      },
    });
  }
  if (plan.rootDuration > context.model.project.duration && !input.extendRoot) {
    return err({
      code: ErrorCode.DurationOverflow,
      message: "scene ordering exceeds the current root duration",
      field: "duration",
      details: {
        limitKind: "root",
        actualSeconds: plan.rootDuration,
        maxSeconds: context.model.project.duration,
        extendRootAllowed: true,
      },
    });
  }
  const operations = [
    ...plan.changes.map((change) => ({
      kind: "setTiming" as const,
      target: change.sceneId,
      value: {
        ...(change.start === undefined ? {} : { start: change.start }),
        ...(change.trackIndex === undefined ? {} : { trackIndex: change.trackIndex }),
      },
    })),
    ...(plan.rootDuration !== context.model.project.duration
      ? [{ kind: "setTiming" as const, target: "@root", value: { duration: plan.rootDuration } }]
      : []),
  ];
  const projected = new Map(plan.changes.map((change) => [change.sceneId, change]));
  const diagnostics = detectTrackGapsAndOverlaps(context.clips.map((clip) => {
    const change = projected.get(clip.sceneId);
    return { ...clip, start: change?.start ?? clip.start, trackIndex: change?.trackIndex ?? clip.trackIndex };
  }));
  const applied = await dependencies.composition.applyOps(context.ref, context.ref.entry, operations);
  if (!applied.ok) return applied;
  const written = await dependencies.authority.mutateSource({
    ref: context.ref,
    steps: [{
      kind: "write",
      path: context.ref.entry,
      content: applied.value,
      expectedContentHash: context.contentHash,
    }],
    ...invocation,
    diagnostics,
    backup: false,
  }, actor);
  if (!written.ok) return written;
  return ok({
    changed: true,
    project: {
      ...context.model.project,
      duration: plan.rootDuration,
      updatedAt: dependencies.clock.now().toISOString(),
      revision: written.value.projectRevision,
    },
    envelope: written.value,
    changes: plan.changes,
    diagnostics: written.value.diagnostics,
  });
}
