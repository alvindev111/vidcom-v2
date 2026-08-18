// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  beginDrag,
  cancelDrag,
  commitDrag,
  createEditorInteractionState,
  moveDrag,
  finishMarquee,
  selectClip,
  startMarquee,
  updateMarquee,
  reduceInteraction,
  timelineSnapCandidates,
  type TimelineClip,
} from "../../src/lib/studio/editor-interaction";

const clips: TimelineClip[] = [
  { sceneId: "a", start: 0, duration: 2, trackIndex: 1 },
  { sceneId: "b", start: 2, duration: 2, trackIndex: 1 },
  { sceneId: "c", start: 4, duration: 1, trackIndex: 1 },
];

describe("timeline editor interaction", () => {
  it("previews a snapped body drag and emits timing only at commit", () => {
    const initial = createEditorInteractionState({ pixelsPerSecond: 100, snapEnabled: true });
    const dragging = beginDrag(initial, {
      clip: { sceneId: "a", start: 1, duration: 2, trackIndex: 1 },
      clips,
      zone: "body",
      pointerX: 100,
      ripple: false,
    });
    expect(commitDrag(dragging)).toBeNull();

    const moved = moveDrag(dragging, {
      pointerX: 250,
      fps: 30,
      candidates: [{ time: 2.55, kind: "playhead", id: "playhead" }],
    });
    expect(moved.drag).toMatchObject({
      preview: { start: 2.55, duration: 2 },
      snappedTo: { id: "playhead" },
      rippleSceneCount: 0,
    });
    expect(commitDrag(moved)).toEqual({
      sceneId: "a",
      timing: { start: 2.55 },
      ripple: false,
    });
  });

  it("keeps the opposite edge fixed while trimming left or right", () => {
    const initial = createEditorInteractionState({ pixelsPerSecond: 100, snapEnabled: false });
    const clip = { sceneId: "a", start: 1, duration: 2, trackIndex: 1 };
    const left = moveDrag(beginDrag(initial, {
      clip, clips, zone: "trim-start", pointerX: 100, ripple: false,
    }), { pointerX: 150, fps: 10, candidates: [] });
    expect(left.drag?.preview).toMatchObject({ start: 1.5, duration: 1.5 });
    const leftCommit = commitDrag(left);
    expect(leftCommit && "timing" in leftCommit ? leftCommit.timing : null)
      .toEqual({ start: 1.5, duration: 1.5 });

    const right = moveDrag(beginDrag(initial, {
      clip, clips, zone: "trim-end", pointerX: 100, ripple: false,
    }), { pointerX: 200, fps: 10, candidates: [] });
    expect(right.drag?.preview).toMatchObject({ start: 1, duration: 3 });
    const rightCommit = commitDrag(right);
    expect(rightCommit && "timing" in rightCommit ? rightCommit.timing : null)
      .toEqual({ duration: 3 });
  });

  it("uses Core ripple planning to expose the moved-scene count", () => {
    const initial = createEditorInteractionState({ pixelsPerSecond: 100, snapEnabled: false });
    const moved = moveDrag(beginDrag(initial, {
      clip: clips[0]!, clips, zone: "trim-end", pointerX: 200, ripple: true,
    }), { pointerX: 300, fps: 30, candidates: [] });

    expect(moved.drag).toMatchObject({
      preview: { start: 0, duration: 3 },
      rippleSceneCount: 2,
    });
    expect(commitDrag(moved)).toEqual({
      sceneId: "a",
      timing: { duration: 3 },
      ripple: true,
    });
  });

  it("rounds free motion to frames and cancels or no-ops without a commit", () => {
    const initial = createEditorInteractionState({ pixelsPerSecond: 100, snapEnabled: false });
    const dragging = beginDrag(initial, {
      clip: clips[0]!, clips, zone: "body", pointerX: 0, ripple: false,
    });
    const unchanged = moveDrag(dragging, { pointerX: 0, fps: 30, candidates: [] });
    expect(commitDrag(unchanged)).toBeNull();

    const framed = moveDrag(dragging, { pointerX: 1.7, fps: 30, candidates: [] });
    expect(framed.drag?.preview.start).toBeCloseTo(1 / 30);
    expect(cancelDrag(framed)).toMatchObject({ drag: null });
    const escaped = reduceInteraction(framed, { type: "escape" });
    expect(escaped).toMatchObject({ drag: null });
    expect(commitDrag(escaped)).toBeNull();
  });

  it("builds snap markers from same-track edges, playhead and ruler seconds", () => {
    const candidates = timelineSnapCandidates({
      clip: clips[0]!, clips, playhead: 1.25, duration: 5,
    });
    expect(candidates).toContainEqual({ time: 2, kind: "clip-edge", id: "b:start" });
    expect(candidates).toContainEqual({ time: 1.25, kind: "playhead", id: "playhead" });
    expect(candidates).toContainEqual({ time: 5, kind: "ruler", id: "second-5" });
    expect(candidates.some(({ id }) => id.startsWith("a:"))).toBe(false);
  });

  it("selects same-track ranges, resets cross-track anchors and toggles one clip", () => {
    const multiTrack = [...clips, { sceneId: "d", start: 1, duration: 1, trackIndex: 2 }];
    let state = createEditorInteractionState({ pixelsPerSecond: 100, snapEnabled: true });
    state = selectClip(state, multiTrack, "a", {});
    state = selectClip(state, multiTrack, "c", { shift: true });
    expect([...state.selection]).toEqual(["a", "b", "c"]);
    expect(state.anchorSceneId).toBe("a");

    state = selectClip(state, multiTrack, "d", { shift: true });
    expect([...state.selection]).toEqual(["d"]);
    expect(state.anchorSceneId).toBe("d");

    state = selectClip(state, multiTrack, "b", { additive: true });
    expect([...state.selection]).toEqual(["d", "b"]);
    state = selectClip(state, multiTrack, "d", { additive: true });
    expect([...state.selection]).toEqual(["b"]);
  });

  it("selects every clip intersecting a marquee rectangle", () => {
    let state = startMarquee(
      createEditorInteractionState({ pixelsPerSecond: 100, snapEnabled: true }),
      { x: 10, y: 10 },
    );
    state = updateMarquee(state, { x: 150, y: 55 });
    state = finishMarquee(state, [
      { sceneId: "a", left: 20, top: 20, right: 80, bottom: 40 },
      { sceneId: "b", left: 120, top: 45, right: 200, bottom: 70 },
      { sceneId: "c", left: 160, top: 20, right: 220, bottom: 40 },
    ]);
    expect([...state.selection]).toEqual(["a", "b"]);
    expect(state.anchorSceneId).toBe("a");
    expect(state.marquee).toBeNull();
  });

  it("moves a selected group by the snapped anchor delta with ripple disabled", () => {
    let initial = createEditorInteractionState({ pixelsPerSecond: 100, snapEnabled: true });
    initial = { ...initial, selection: new Set(["a", "c"]), anchorSceneId: "a" };
    const dragging = beginDrag(initial, {
      clip: clips[0]!, clips, zone: "body", pointerX: 0, ripple: true,
      selectedSceneIds: initial.selection,
    });
    const candidates = timelineSnapCandidates({
      clip: clips[0]!, clips, playhead: 3, duration: 10, excludedSceneIds: initial.selection,
    });
    expect(candidates.some(({ id }) => id.startsWith("c:"))).toBe(false);
    const moved = moveDrag(dragging, { pointerX: 100, fps: 30, candidates });
    expect(moved.drag?.groupPreview).toEqual([
      { sceneId: "a", start: 1, duration: 2, trackIndex: 1 },
      { sceneId: "c", start: 5, duration: 1, trackIndex: 1 },
    ]);
    expect(moved.drag?.rippleSceneCount).toBe(0);
    expect(commitDrag(moved)).toEqual({ sceneIds: ["a", "c"], deltaSeconds: 1 });
  });
});
