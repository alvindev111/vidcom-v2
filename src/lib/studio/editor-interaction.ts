import {
  roundToFrame,
  snapTime,
  snapToleranceSeconds,
  type SnapCandidate,
} from "./snap";

export type DragZone = "body" | "trim-start" | "trim-end";

export interface TimelineClip {
  sceneId: string;
  start: number;
  duration: number;
  trackIndex: number;
}

export interface DragSession {
  clip: TimelineClip;
  clips: readonly TimelineClip[];
  zone: DragZone;
  pointerX: number;
  ripple: boolean;
  preview: TimelineClip;
  snappedTo: SnapCandidate | null;
  rippleSceneCount: number;
  moved: boolean;
}

export interface EditorInteractionState {
  mode: "select" | "split";
  snapEnabled: boolean;
  pixelsPerSecond: number;
  selection: ReadonlySet<string>;
  anchorSceneId: string | null;
  drag: DragSession | null;
  marquee: { fromX: number; fromY: number; toX: number; toY: number } | null;
}

export interface TimingCommit {
  sceneId: string;
  timing: { start?: number; duration?: number };
  ripple: boolean;
}

export type InteractionEvent =
  | { type: "begin-drag"; input: BeginDragInput }
  | { type: "move-drag"; input: MoveDragInput }
  | { type: "escape" };

export interface BeginDragInput {
  clip: TimelineClip;
  clips: readonly TimelineClip[];
  zone: DragZone;
  pointerX: number;
  ripple: boolean;
}

export interface MoveDragInput {
  pointerX: number;
  fps: number;
  candidates: readonly SnapCandidate[];
}

export function timelineSnapCandidates(input: {
  clip: TimelineClip;
  clips: readonly TimelineClip[];
  playhead: number;
  duration: number;
}): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];
  for (const clip of input.clips) {
    if (clip.sceneId === input.clip.sceneId || clip.trackIndex !== input.clip.trackIndex) continue;
    candidates.push(
      { time: clip.start, kind: "clip-edge", id: `${clip.sceneId}:start` },
      { time: clip.start + clip.duration, kind: "clip-edge", id: `${clip.sceneId}:end` },
    );
  }
  candidates.push({ time: input.playhead, kind: "playhead", id: "playhead" });
  for (let second = 0; second <= Math.floor(input.duration); second += 1) {
    candidates.push({ time: second, kind: "ruler", id: `second-${second}` });
  }
  return candidates;
}

export function createEditorInteractionState(input: {
  pixelsPerSecond: number;
  snapEnabled: boolean;
}): EditorInteractionState {
  return {
    mode: "select",
    snapEnabled: input.snapEnabled,
    pixelsPerSecond: input.pixelsPerSecond,
    selection: new Set(),
    anchorSceneId: null,
    drag: null,
    marquee: null,
  };
}

export function beginDrag(
  state: EditorInteractionState,
  input: BeginDragInput,
): EditorInteractionState {
  return {
    ...state,
    drag: {
      clip: input.clip,
      clips: input.clips,
      zone: input.zone,
      pointerX: input.pointerX,
      ripple: input.ripple,
      preview: input.clip,
      snappedTo: null,
      rippleSceneCount: 0,
      moved: false,
    },
  };
}

function snappedBodyStart(
  start: number,
  duration: number,
  candidates: readonly SnapCandidate[],
  tolerance: number,
): { time: number; candidate: SnapCandidate | null } {
  const startResult = snapTime(start, candidates, tolerance);
  const endResult = snapTime(start + duration, candidates, tolerance);
  const startCorrection = Math.abs(startResult.time - start);
  const endCorrection = Math.abs(endResult.time - (start + duration));
  return endResult.candidate && (!startResult.candidate || endCorrection < startCorrection)
    ? { time: endResult.time - duration, candidate: endResult.candidate }
    : startResult;
}

/** Optimistic count only; the Core planner remains authoritative for committed timing. */
function rippleSceneCount(
  clips: readonly TimelineClip[],
  preview: TimelineClip,
): number {
  const track = clips
    .filter((clip) => clip.trackIndex === preview.trackIndex)
    .sort((left, right) => left.start - right.start || left.sceneId.localeCompare(right.sceneId));
  const targetIndex = track.findIndex((clip) => clip.sceneId === preview.sceneId);
  if (targetIndex < 0) return 0;
  const original = track[targetIndex]!;
  const previous = track[targetIndex - 1];
  if (previous && preview.start !== previous.start + previous.duration) return 0;
  let count = preview.start === original.start ? 0 : 1;
  let cursor = preview.start + preview.duration;
  for (const clip of track.slice(targetIndex + 1)) {
    if (clip.start !== cursor) count += 1;
    cursor += clip.duration;
  }
  return count;
}

export function moveDrag(
  state: EditorInteractionState,
  input: MoveDragInput,
): EditorInteractionState {
  const drag = state.drag;
  if (!drag) return state;
  const frame = 1 / input.fps;
  const delta = (input.pointerX - drag.pointerX) / state.pixelsPerSecond;
  const end = drag.clip.start + drag.clip.duration;
  const tolerance = snapToleranceSeconds(state.pixelsPerSecond, input.fps);
  let start = drag.clip.start;
  let duration = drag.clip.duration;
  let snappedTo: SnapCandidate | null = null;

  if (drag.zone === "body") {
    const raw = drag.clip.start + delta;
    const projected = state.snapEnabled
      ? snappedBodyStart(raw, drag.clip.duration, input.candidates, tolerance)
      : { time: roundToFrame(raw, input.fps), candidate: null };
    start = Math.max(0, projected.time);
    snappedTo = start === projected.time ? projected.candidate : null;
  } else if (drag.zone === "trim-start") {
    const raw = drag.clip.start + delta;
    const projected = state.snapEnabled
      ? snapTime(raw, input.candidates, tolerance)
      : { time: roundToFrame(raw, input.fps), candidate: null };
    start = Math.max(0, Math.min(projected.time, end - frame));
    duration = end - start;
    snappedTo = start === projected.time ? projected.candidate : null;
  } else {
    const rawEnd = end + delta;
    const projected = state.snapEnabled
      ? snapTime(rawEnd, input.candidates, tolerance)
      : { time: roundToFrame(rawEnd, input.fps), candidate: null };
    const nextEnd = Math.max(drag.clip.start + frame, projected.time);
    duration = nextEnd - drag.clip.start;
    snappedTo = nextEnd === projected.time ? projected.candidate : null;
  }

  const preview = { ...drag.clip, start, duration };
  const changed = start !== drag.clip.start || duration !== drag.clip.duration;
  return {
    ...state,
    drag: {
      ...drag,
      preview,
      snappedTo,
      rippleSceneCount: drag.ripple && changed ? rippleSceneCount(drag.clips, preview) : 0,
      moved: changed,
    },
  };
}

export function cancelDrag(state: EditorInteractionState): EditorInteractionState {
  return state.drag ? { ...state, drag: null } : state;
}

export function commitDrag(state: EditorInteractionState): TimingCommit | null {
  const drag = state.drag;
  if (!drag?.moved) return null;
  const timing = drag.zone === "body"
    ? { start: drag.preview.start }
    : drag.zone === "trim-start"
      ? { start: drag.preview.start, duration: drag.preview.duration }
      : { duration: drag.preview.duration };
  return { sceneId: drag.clip.sceneId, timing, ripple: drag.ripple };
}

export function reduceInteraction(
  state: EditorInteractionState,
  event: InteractionEvent,
): EditorInteractionState {
  if (event.type === "begin-drag") return beginDrag(state, event.input);
  if (event.type === "move-drag") return moveDrag(state, event.input);
  return cancelDrag(state);
}
