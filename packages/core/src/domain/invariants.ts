import { ErrorCode, type Diagnostic, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";

export interface SceneClip {
  sceneId: string;
  start: number;
  duration: number;
  trackIndex: number;
}

export interface TimingChange {
  sceneId: string;
  start?: number;
  duration?: number;
}

export interface TrackRipplePlan {
  trackIndex: number;
  moved: { sceneId: string; fromStart: number; toStart: number }[];
  rootDuration: number;
}

/** Timing values whose business invariants are checked by Core. */
export interface SceneTimingInput {
  start: number;
  duration: number;
  trackIndex: number;
  rootDuration: number;
}

/** Returns the first timing invariant failure, or `null` when the timing is valid. */
export function validateSceneTiming(input: SceneTimingInput): DomainError | null {
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    return {
      code: ErrorCode.TimingInvalid,
      message: "duration must be greater than zero",
      field: "duration",
    };
  }
  if (!Number.isFinite(input.start) || input.start < 0) {
    return {
      code: ErrorCode.TimingInvalid,
      message: "start must be zero or greater",
      field: "start",
    };
  }
  if (!Number.isInteger(input.trackIndex)) {
    return {
      code: ErrorCode.TimingInvalid,
      message: "trackIndex must be an integer",
      field: "trackIndex",
    };
  }
  const end = input.start + input.duration;
  if (!Number.isFinite(end) || end > input.rootDuration) {
    return {
      code: ErrorCode.DurationOverflow,
      message: "scene timing exceeds the root duration",
      field: "duration",
    };
  }
  return null;
}

/** Plans a timing ripple inside one track and computes root duration across every track. */
export function planRipple(scenes: readonly SceneClip[], change: TimingChange): Result<TrackRipplePlan, DomainError> {
  const target = scenes.find((scene) => scene.sceneId === change.sceneId);
  if (!target) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found", field: "sceneId" });
  const nextStart = change.start ?? target.start;
  const nextDuration = change.duration ?? target.duration;
  const invalid = validateSceneTiming({
    start: nextStart, duration: nextDuration, trackIndex: target.trackIndex,
    rootDuration: Number.POSITIVE_INFINITY,
  });
  if (invalid) return err(invalid);

  const changed = new Map<string, SceneClip>();
  const track = scenes.filter((scene) => scene.trackIndex === target.trackIndex)
    .sort((left, right) => left.start - right.start || left.sceneId.localeCompare(right.sceneId));
  const targetIndex = track.findIndex((scene) => scene.sceneId === target.sceneId);
  const previous = track[targetIndex - 1];
  if (previous && nextStart !== previous.start + previous.duration) {
    return err({ code: ErrorCode.TimingInvalid, message: "ripple start must remain adjacent to the previous scene", field: "start" });
  }
  changed.set(target.sceneId, { ...target, start: nextStart, duration: nextDuration });
  let cursor = nextStart + nextDuration;
  const moved: TrackRipplePlan["moved"] = [];
  if (nextStart !== target.start) moved.push({ sceneId: target.sceneId, fromStart: target.start, toStart: nextStart });
  for (const scene of track.slice(targetIndex + 1)) {
    changed.set(scene.sceneId, { ...scene, start: cursor });
    if (scene.start !== cursor) moved.push({ sceneId: scene.sceneId, fromStart: scene.start, toStart: cursor });
    cursor += scene.duration;
  }
  const rootDuration = scenes.reduce((maximum, scene) => {
    const value = changed.get(scene.sceneId) ?? scene;
    return Math.max(maximum, value.start + value.duration);
  }, 0);
  return ok({ trackIndex: target.trackIndex, moved, rootDuration });
}

/** Reports gaps and overlaps only between adjacent scenes in the same track. */
export function detectTrackGapsAndOverlaps(scenes: readonly SceneClip[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const tracks = new Map<number, SceneClip[]>();
  for (const scene of scenes) tracks.set(scene.trackIndex, [...(tracks.get(scene.trackIndex) ?? []), scene]);
  for (const [trackIndex, track] of tracks) {
    track.sort((left, right) => left.start - right.start || left.sceneId.localeCompare(right.sceneId));
    for (let index = 1; index < track.length; index += 1) {
      const previous = track[index - 1]!;
      const current = track[index]!;
      const previousEnd = previous.start + previous.duration;
      if (current.start === previousEnd) continue;
      const overlap = current.start < previousEnd;
      diagnostics.push({
        severity: "warning",
        code: overlap ? "track-overlap" : "track-gap",
        sceneId: current.sceneId,
        message: `track ${trackIndex} has a ${overlap ? "overlap" : "gap"} between ${previous.sceneId} and ${current.sceneId}`,
      });
    }
  }
  return diagnostics;
}
