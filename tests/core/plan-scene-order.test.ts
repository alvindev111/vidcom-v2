// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ErrorCode, type RelPath } from "@vidcom/contracts";
import { FrameGrid } from "../../packages/core/src/domain/frame-grid";
import {
  groupOf,
  planCompact,
  planGroupShift,
  planReorder,
  planSceneInsertion,
  type SceneGroups,
} from "../../packages/core/src/domain/plan-scene-order";

const clips = [
  { sceneId: "a", start: 1, duration: 2, trackIndex: 1 },
  { sceneId: "b", start: 5, duration: 1, trackIndex: 1 },
  { sceneId: "c", start: 8, duration: 3, trackIndex: 1 },
  { sceneId: "overlay", start: 0, duration: 12, trackIndex: 1 },
] as const;
const groups: SceneGroups = { a: "scene", b: "scene", c: "scene", overlay: "overlay" };

describe("scene order planners", () => {
  it("classifies content, transition and overlay scenes inside Core", () => {
    expect(groupOf({ id: "plain", isTransition: false, block: null })).toBe("scene");
    expect(groupOf({ id: "wipe", isTransition: true, block: null })).toBe("transition");
    expect(groupOf({ id: "lower-third", isTransition: false, block: { tags: ["overlay"] } })).toBe("overlay");
    expect(groupOf({ id: "hand-overlay", isTransition: false, block: null })).toBe("overlay");
  });

  it("reorders within one track/group while retaining positional gaps", () => {
    const planned = planReorder(clips, groups, { sceneId: "c", toIndex: 0 });

    expect(planned).toEqual({
      ok: true,
      value: {
        changes: [
          { sceneId: "c", start: 1 },
          { sceneId: "a", start: 6 },
          { sceneId: "b", start: 10 },
        ],
        rootDuration: 12,
        noOp: false,
      },
    });
    expect(planReorder(clips, groups, { sceneId: "b", toIndex: 1 }))
      .toMatchObject({ ok: true, value: { changes: [], noOp: true } });
    expect(planReorder(clips, groups, { sceneId: "a", toIndex: 3 }))
      .toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid } });
  });

  it("moves across tracks without compacting the source and adds one zero target boundary", () => {
    const crossTrack = [
      { sceneId: "move", start: 10, duration: 3, trackIndex: 1 },
      { sceneId: "stay", start: 15, duration: 1, trackIndex: 1 },
      { sceneId: "t1", start: 2, duration: 2, trackIndex: 2 },
      { sceneId: "t2", start: 6, duration: 1, trackIndex: 2 },
    ];
    const planned = planReorder(
      crossTrack,
      { move: "scene", stay: "scene", t1: "scene", t2: "scene" },
      { sceneId: "move", toIndex: 1, toTrackIndex: 2 },
    );

    expect(planned).toMatchObject({
      ok: true,
      value: {
        changes: [
          { sceneId: "move", start: 6, trackIndex: 2 },
          { sceneId: "t2", start: 9 },
        ],
        rootDuration: 16,
        noOp: false,
      },
    });
  });

  it("keeps overlap as a valid gap slot instead of treating it as validation", () => {
    expect(planReorder([
      { sceneId: "a", start: 0, duration: 4, trackIndex: 1 },
      { sceneId: "b", start: 2, duration: 4, trackIndex: 1 },
    ], { a: "scene", b: "scene" }, { sceneId: "b", toIndex: 0 })).toEqual({
      ok: true,
      value: {
        changes: [
          { sceneId: "b", start: 0 },
          { sceneId: "a", start: 2 },
        ],
        rootDuration: 6,
        noOp: false,
      },
    });
  });

  it("compacts only the requested track and keeps other tracks in root duration", () => {
    expect(planCompact([
      { sceneId: "a", start: 2, duration: 2, trackIndex: 1 },
      { sceneId: "b", start: 7, duration: 1, trackIndex: 1 },
      { sceneId: "other", start: 10, duration: 2, trackIndex: 2 },
    ], 1)).toEqual({
      changes: [
        { sceneId: "a", start: 0 },
        { sceneId: "b", start: 2 },
      ],
      rootDuration: 12,
      noOp: false,
    });
  });

  it("shifts a group all-or-nothing and rejects duplicates or a negative result", () => {
    const shifted = planGroupShift(clips, ["a", "b"], 2);
    expect(shifted).toMatchObject({
      ok: true,
      value: {
        changes: [
          { sceneId: "a", start: 3 },
          { sceneId: "b", start: 7 },
        ],
        rootDuration: 12,
      },
    });
    expect(planGroupShift(clips, ["a", "a"], 1))
      .toMatchObject({ ok: false, error: { code: ErrorCode.DuplicateMutationTarget } });
    expect(planGroupShift(clips, ["a", "b"], -2))
      .toMatchObject({ ok: false, error: { code: ErrorCode.TimingInvalid } });
  });

  it("plans insertion timing, tail shift, root duration and document anchor without writing", () => {
    const planned = planSceneInsertion([
      { sceneId: "a", start: 0, duration: 2, trackIndex: 1 },
      { sceneId: "b", start: 5, duration: 1, trackIndex: 1 },
      { sceneId: "other", start: 0, duration: 4, trackIndex: 2 },
    ], {
      sceneId: "new",
      scenePath: "compositions/new.html" as RelPath,
      duration: 3,
      toIndex: 1,
      trackIndex: 1,
      rootDuration: 6,
    }, FrameGrid.fromFps(30));

    expect(planned).toEqual({
      ok: true,
      value: {
        scene: {
          sceneId: "new",
          scenePath: "compositions/new.html",
          start: 2,
          duration: 3,
          trackIndex: 1,
        },
        changes: [{ sceneId: "b", start: 8 }],
        beforeSceneId: "b",
        rootDuration: 9,
        noOp: false,
      },
    });
  });
});
