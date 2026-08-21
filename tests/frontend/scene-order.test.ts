// @vitest-environment node

import { describe, expect, it } from "vitest";

import { keyboardReorderIntent, reorderDropIntent } from "../../src/lib/studio/scene-order";
import type { Scene } from "../../src/lib/studio/types";

const scene = (id: string, start: number, trackIndex = 1, isTransition = false): Scene => ({
  id, start, duration: 1, trackIndex, isTransition, src: null, sourceFile: "index.html", role: isTransition ? "transition" : "story", block: null,
  media: [], script: [], narration: null, elements: [], unresolvedEffects: 0,
});
const scenes = [scene("a", 0), scene("b", 2), scene("c", 4), scene("other", 1, 2), scene("transition", 3, 1, true)];

describe("studio scene reorder intent", () => {
  it("derives group-relative insertion without calculating timing", () => {
    expect(reorderDropIntent(scenes, "c", "a", "before")).toEqual({
      kind: "ready", sceneId: "c", toIndex: 0,
    });
    expect(reorderDropIntent(scenes, "a", "b", "after")).toEqual({
      kind: "ready", sceneId: "a", toIndex: 1,
    });
  });

  it("rejects cross-group storyboard drops and carries target track for timeline drops", () => {
    expect(reorderDropIntent(scenes, "a", "transition", "before")).toMatchObject({
      kind: "rejected", message: expect.stringContaining("group"),
    });
    expect(reorderDropIntent(scenes, "a", "other", "before", { allowCrossTrack: true })).toEqual({
      kind: "ready", sceneId: "a", toIndex: 0, toTrackIndex: 2,
    });
  });

  it("maps keyboard movement within one group/track and no-ops at boundaries", () => {
    expect(keyboardReorderIntent(scenes, "b", -1)).toEqual({ kind: "ready", sceneId: "b", toIndex: 0 });
    expect(keyboardReorderIntent(scenes, "a", -1)).toEqual({ kind: "boundary" });
    expect(keyboardReorderIntent(scenes, "c", 1)).toEqual({ kind: "boundary" });
  });
});
