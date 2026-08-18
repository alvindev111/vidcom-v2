import { ErrorCode, type DomainError, type RelPath } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import type { SceneClip } from "./invariants";

export type SceneGroup = "scene" | "transition" | "overlay";
export type SceneGroups = Readonly<Record<string, SceneGroup>>;

export interface SceneGroupSource {
  id: string;
  isTransition: boolean;
  block: { tags: readonly string[] } | null;
}

export interface SceneOrderChange {
  sceneId: string;
  start?: number;
  trackIndex?: number;
}

export interface ReorderPlan {
  changes: SceneOrderChange[];
  rootDuration: number;
  noOp: boolean;
}

export interface SceneInsertionPlan extends ReorderPlan {
  scene: SceneClip & { scenePath: RelPath };
  beforeSceneId: string | null;
}

export function groupOf(scene: SceneGroupSource): SceneGroup {
  if (scene.isTransition) return "transition";
  if (scene.block?.tags.includes("overlay")) return "overlay";
  return /overlay/iu.test(scene.id) ? "overlay" : "scene";
}

function byStart(left: SceneClip, right: SceneClip): number {
  return left.start - right.start || left.sceneId.localeCompare(right.sceneId);
}

function rootDuration(clips: readonly SceneClip[], changes: readonly SceneOrderChange[]): number {
  const projected = new Map(changes.map((change) => [change.sceneId, change]));
  return clips.reduce((maximum, clip) => {
    const change = projected.get(clip.sceneId);
    return Math.max(maximum, (change?.start ?? clip.start) + clip.duration);
  }, 0);
}

function gapSlots(clips: readonly SceneClip[]): number[] {
  if (clips.length === 0) return [];
  return clips.map((clip, index) => index === 0
    ? clip.start
    : clip.start - (clips[index - 1]!.start + clips[index - 1]!.duration));
}

function assignSlots(
  ordered: readonly SceneClip[],
  gaps: readonly number[],
  targetTrackIndex: number,
): Result<SceneOrderChange[], DomainError> {
  const changes: SceneOrderChange[] = [];
  let cursor = 0;
  for (const [index, clip] of ordered.entries()) {
    const start = index === 0 ? gaps[0] ?? 0 : cursor + (gaps[index] ?? 0);
    if (!Number.isFinite(start) || start < 0) {
      return err({
        code: ErrorCode.TimingInvalid,
        message: "scene ordering would produce a negative or non-finite start",
        field: "start",
      });
    }
    const change: SceneOrderChange = { sceneId: clip.sceneId };
    if (start !== clip.start) change.start = start;
    if (targetTrackIndex !== clip.trackIndex) change.trackIndex = targetTrackIndex;
    if (change.start !== undefined || change.trackIndex !== undefined) changes.push(change);
    cursor = start + clip.duration;
  }
  return ok(changes);
}

export function planReorder(
  clips: readonly SceneClip[],
  groups: SceneGroups,
  request: { sceneId: string; toIndex: number; toTrackIndex?: number },
): Result<ReorderPlan, DomainError> {
  const moving = clips.find((clip) => clip.sceneId === request.sceneId);
  if (!moving) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found", field: "sceneId" });
  const group = groups[moving.sceneId];
  if (!group) return err({ code: ErrorCode.Internal, message: "scene group classification is missing" });
  const targetTrackIndex = request.toTrackIndex ?? moving.trackIndex;
  if (!Number.isInteger(targetTrackIndex)) {
    return err({ code: ErrorCode.TimingInvalid, message: "trackIndex must be an integer", field: "toTrackIndex" });
  }

  const sameTrack = targetTrackIndex === moving.trackIndex;
  const original = clips
    .filter((clip) => clip.trackIndex === targetTrackIndex && groups[clip.sceneId] === group)
    .sort(byStart);
  const withoutMoving = original.filter((clip) => clip.sceneId !== moving.sceneId);
  const maximumIndex = sameTrack ? withoutMoving.length : original.length;
  if (!Number.isInteger(request.toIndex) || request.toIndex < 0 || request.toIndex > maximumIndex) {
    return err({
      code: ErrorCode.SchemaInvalid,
      message: "toIndex is outside the scene group in the target track",
      field: "toIndex",
    });
  }

  if (sameTrack) {
    const ordered = [...withoutMoving];
    ordered.splice(request.toIndex, 0, moving);
    const assigned = assignSlots(ordered, gapSlots(original), targetTrackIndex);
    if (!assigned.ok) return assigned;
    const plan = {
      changes: assigned.value,
      rootDuration: rootDuration(clips, assigned.value),
      noOp: assigned.value.length === 0,
    };
    return ok(plan);
  }

  const ordered = [...original];
  ordered.splice(request.toIndex, 0, moving);
  const gaps = gapSlots(original);
  if (gaps.length === 0) gaps.push(0);
  else gaps.splice(Math.min(request.toIndex + 1, gaps.length), 0, 0);
  const assigned = assignSlots(ordered, gaps, targetTrackIndex);
  if (!assigned.ok) return assigned;
  return ok({
    changes: assigned.value,
    rootDuration: rootDuration(clips, assigned.value),
    noOp: assigned.value.length === 0,
  });
}

export function planCompact(clips: readonly SceneClip[], trackIndex: number): ReorderPlan {
  const track = clips.filter((clip) => clip.trackIndex === trackIndex).sort(byStart);
  const changes: SceneOrderChange[] = [];
  let cursor = 0;
  for (const clip of track) {
    if (clip.start !== cursor) changes.push({ sceneId: clip.sceneId, start: cursor });
    cursor += clip.duration;
  }
  return {
    changes,
    rootDuration: rootDuration(clips, changes),
    noOp: changes.length === 0,
  };
}

export function planGroupShift(
  clips: readonly SceneClip[],
  sceneIds: readonly string[],
  deltaSeconds: number,
): Result<ReorderPlan, DomainError> {
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
  if (!Number.isFinite(deltaSeconds)) {
    return err({ code: ErrorCode.TimingInvalid, message: "deltaSeconds must be finite", field: "deltaSeconds" });
  }
  const byId = new Map(clips.map((clip) => [clip.sceneId, clip]));
  const selected: SceneClip[] = [];
  for (const sceneId of sceneIds) {
    const clip = byId.get(sceneId);
    if (!clip) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found", field: "sceneIds" });
    selected.push(clip);
  }
  if (selected.some((clip) => !Number.isFinite(clip.start + deltaSeconds) || clip.start + deltaSeconds < 0)) {
    return err({
      code: ErrorCode.TimingInvalid,
      message: "group shift would produce a negative or non-finite start",
      field: "deltaSeconds",
    });
  }
  const changes = deltaSeconds === 0
    ? []
    : selected.map((clip) => ({ sceneId: clip.sceneId, start: clip.start + deltaSeconds }));
  return ok({ changes, rootDuration: rootDuration(clips, changes), noOp: changes.length === 0 });
}

export function planSceneInsertion(
  clips: readonly SceneClip[],
  request: {
    sceneId: string;
    scenePath: RelPath;
    duration: number;
    toIndex: number;
    trackIndex: number;
    rootDuration: number;
  },
): Result<SceneInsertionPlan, DomainError> {
  if (clips.some((clip) => clip.sceneId === request.sceneId)) {
    return err({
      code: ErrorCode.DuplicateMutationTarget,
      message: "sceneId already exists",
      field: "sceneId",
    });
  }
  if (!Number.isFinite(request.duration) || request.duration <= 0) {
    return err({ code: ErrorCode.TimingInvalid, message: "duration must be greater than zero", field: "duration" });
  }
  if (!Number.isInteger(request.trackIndex)) {
    return err({ code: ErrorCode.TimingInvalid, message: "trackIndex must be an integer", field: "trackIndex" });
  }
  const track = clips.filter((clip) => clip.trackIndex === request.trackIndex).sort(byStart);
  if (!Number.isInteger(request.toIndex) || request.toIndex < 0 || request.toIndex > track.length) {
    return err({ code: ErrorCode.SchemaInvalid, message: "toIndex is outside the target track", field: "toIndex" });
  }
  const start = request.toIndex === 0
    ? 0
    : track[request.toIndex - 1]!.start + track[request.toIndex - 1]!.duration;
  const changes = track.slice(request.toIndex).map((clip) => ({
    sceneId: clip.sceneId,
    start: clip.start + request.duration,
  }));
  const scene = {
    sceneId: request.sceneId,
    scenePath: request.scenePath,
    start,
    duration: request.duration,
    trackIndex: request.trackIndex,
  };
  return ok({
    scene,
    changes,
    beforeSceneId: track[request.toIndex]?.sceneId ?? null,
    rootDuration: Math.max(
      request.rootDuration,
      start + request.duration,
      rootDuration([...clips, scene], changes),
    ),
    noOp: false,
  });
}
