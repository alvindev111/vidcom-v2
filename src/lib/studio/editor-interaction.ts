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
  groupSceneIds: readonly string[];
  groupPreview: readonly TimelineClip[];
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

export interface GroupMoveCommit {
  sceneIds: string[];
  deltaSeconds: number;
}

export type EditorCommit = TimingCommit | GroupMoveCommit;

export interface Point {
  x: number;
  y: number;
}

export interface ClipBounds {
  sceneId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
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
  selectedSceneIds?: ReadonlySet<string>;
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
  fps: number;
  excludedSceneIds?: ReadonlySet<string>;
}): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];
  for (const clip of input.clips) {
    if (clip.sceneId === input.clip.sceneId
      || input.excludedSceneIds?.has(clip.sceneId)
      || clip.trackIndex !== input.clip.trackIndex) continue;
    candidates.push(
      { time: clip.start, kind: "clip-edge", id: `${clip.sceneId}:start` },
      { time: clip.start + clip.duration, kind: "clip-edge", id: `${clip.sceneId}:end` },
    );
  }
  candidates.push({ time: input.playhead, kind: "playhead", id: "playhead" });
  for (let second = 0; second <= Math.floor(input.duration); second += 1) {
    candidates.push({ time: second, kind: "ruler", id: `second-${second}` });
  }
  return candidates.map((candidate) => ({
    ...candidate,
    time: roundToFrame(candidate.time, input.fps),
  }));
}

export function selectClip(
  state: EditorInteractionState,
  clips: readonly TimelineClip[],
  sceneId: string,
  modifiers: { shift?: boolean; additive?: boolean },
): EditorInteractionState {
  const clicked = clips.find((clip) => clip.sceneId === sceneId);
  if (!clicked) return state;
  // Pointer-down on a member of an existing group starts a group drag. A plain
  // click outside the selection still replaces it, and modifier clicks retain
  // their range/toggle semantics below.
  if (!modifiers.shift && !modifiers.additive
    && state.selection.size > 1 && state.selection.has(sceneId)) return state;
  if (modifiers.additive) {
    const selection = new Set(state.selection);
    if (selection.has(sceneId)) selection.delete(sceneId);
    else selection.add(sceneId);
    return {
      ...state,
      selection,
      anchorSceneId: selection.has(sceneId) ? sceneId : selection.values().next().value ?? null,
    };
  }
  if (modifiers.shift && state.anchorSceneId) {
    const anchor = clips.find((clip) => clip.sceneId === state.anchorSceneId);
    if (!anchor || anchor.trackIndex !== clicked.trackIndex) {
      return { ...state, selection: new Set([sceneId]), anchorSceneId: sceneId };
    }
    const track = clips
      .filter((clip) => clip.trackIndex === clicked.trackIndex)
      .sort((left, right) => left.start - right.start || left.sceneId.localeCompare(right.sceneId));
    const anchorIndex = track.findIndex((clip) => clip.sceneId === anchor.sceneId);
    const clickedIndex = track.findIndex((clip) => clip.sceneId === sceneId);
    const from = Math.min(anchorIndex, clickedIndex);
    const to = Math.max(anchorIndex, clickedIndex);
    return {
      ...state,
      selection: new Set(track.slice(from, to + 1).map((clip) => clip.sceneId)),
    };
  }
  return { ...state, selection: new Set([sceneId]), anchorSceneId: sceneId };
}

export function clearSelection(state: EditorInteractionState): EditorInteractionState {
  return state.selection.size === 0 && state.anchorSceneId === null && state.marquee === null
    ? state
    : { ...state, selection: new Set(), anchorSceneId: null, marquee: null };
}

export function startMarquee(state: EditorInteractionState, point: Point): EditorInteractionState {
  return { ...state, marquee: { fromX: point.x, fromY: point.y, toX: point.x, toY: point.y } };
}

export function updateMarquee(state: EditorInteractionState, point: Point): EditorInteractionState {
  return state.marquee
    ? { ...state, marquee: { ...state.marquee, toX: point.x, toY: point.y } }
    : state;
}

export function finishMarquee(
  state: EditorInteractionState,
  clips: readonly ClipBounds[],
): EditorInteractionState {
  const marquee = state.marquee;
  if (!marquee) return state;
  const left = Math.min(marquee.fromX, marquee.toX);
  const right = Math.max(marquee.fromX, marquee.toX);
  const top = Math.min(marquee.fromY, marquee.toY);
  const bottom = Math.max(marquee.fromY, marquee.toY);
  const selected = clips.filter((clip) => clip.right >= left && clip.left <= right
    && clip.bottom >= top && clip.top <= bottom).map((clip) => clip.sceneId);
  return {
    ...state,
    selection: new Set(selected),
    anchorSceneId: selected[0] ?? null,
    marquee: null,
  };
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
  const groupSceneIds = input.zone === "body" && input.selectedSceneIds?.has(input.clip.sceneId)
    && input.selectedSceneIds.size > 1
    ? input.clips.filter((clip) => input.selectedSceneIds!.has(clip.sceneId)).map((clip) => clip.sceneId)
    : [];
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
      groupSceneIds,
      groupPreview: groupSceneIds.length > 1
        ? input.clips.filter((clip) => groupSceneIds.includes(clip.sceneId))
        : [],
      moved: false,
    },
  };
}

function snappedBodyStart(
  start: number,
  duration: number,
  candidates: readonly SnapCandidate[],
  tolerance: number,
  fps: number,
): { time: number; candidate: SnapCandidate | null } {
  const startResult = snapTime(start, candidates, tolerance, fps);
  const endResult = snapTime(start + duration, candidates, tolerance, fps);
  const startCorrection = Math.abs(startResult.time - start);
  const endCorrection = Math.abs(endResult.time - (start + duration));
  return endResult.candidate && (!startResult.candidate || endCorrection < startCorrection)
    ? { time: roundToFrame(endResult.time - duration, fps), candidate: endResult.candidate }
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
      ? snappedBodyStart(raw, drag.clip.duration, input.candidates, tolerance, input.fps)
      : snapTime(raw, [], tolerance, input.fps);
    start = Math.max(0, projected.time);
    snappedTo = start === projected.time ? projected.candidate : null;
  } else if (drag.zone === "trim-start") {
    const raw = drag.clip.start + delta;
    const projected = state.snapEnabled
      ? snapTime(raw, input.candidates, tolerance, input.fps)
      : snapTime(raw, [], tolerance, input.fps);
    start = Math.max(0, Math.min(projected.time, end - frame));
    duration = end - start;
    snappedTo = start === projected.time ? projected.candidate : null;
  } else {
    const rawEnd = end + delta;
    const projected = state.snapEnabled
      ? snapTime(rawEnd, input.candidates, tolerance, input.fps)
      : snapTime(rawEnd, [], tolerance, input.fps);
    const nextEnd = Math.max(drag.clip.start + frame, projected.time);
    duration = nextEnd - drag.clip.start;
    snappedTo = nextEnd === projected.time ? projected.candidate : null;
  }

  const preview = { ...drag.clip, start, duration };
  let groupPreview = drag.groupPreview;
  if (drag.groupSceneIds.length > 1 && drag.zone === "body") {
    let delta = start - drag.clip.start;
    const minimumStart = Math.min(...groupPreview.map((clip) => clip.start));
    if (minimumStart + delta < 0) delta = -minimumStart;
    groupPreview = groupPreview.map((clip) => ({ ...clip, start: clip.start + delta }));
    start = drag.clip.start + delta;
  }
  const changed = start !== drag.clip.start || duration !== drag.clip.duration;
  return {
    ...state,
    drag: {
      ...drag,
      preview: { ...preview, start },
      snappedTo,
      rippleSceneCount: drag.groupSceneIds.length > 1
        ? 0
        : drag.ripple && changed ? rippleSceneCount(drag.clips, preview) : 0,
      groupPreview,
      moved: changed,
    },
  };
}

export function cancelDrag(state: EditorInteractionState): EditorInteractionState {
  return state.drag ? { ...state, drag: null } : state;
}

export function commitDrag(state: EditorInteractionState): EditorCommit | null {
  const drag = state.drag;
  if (!drag?.moved) return null;
  if (drag.groupSceneIds.length > 1 && drag.zone === "body") {
    return {
      sceneIds: [...drag.groupSceneIds],
      deltaSeconds: drag.preview.start - drag.clip.start,
    };
  }
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
  return clearSelection(cancelDrag(state));
}
