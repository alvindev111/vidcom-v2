import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import { detectTrackGapsAndOverlaps, planRipple, validateSceneTiming } from "@vidcom/core";

describe("scene timing invariants", () => {
  it("accepts timing fully contained by the root", () => {
    expect(validateSceneTiming({ start: 2, duration: 3, trackIndex: 0, rootDuration: 5 })).toBeNull();
  });

  it.each([
    [{ start: 0, duration: 0, trackIndex: 0, rootDuration: 5 }, "duration"],
    [{ start: -1, duration: 1, trackIndex: 0, rootDuration: 5 }, "start"],
    [{ start: 0, duration: 1, trackIndex: 0.5, rootDuration: 5 }, "trackIndex"],
  ] as const)("rejects invalid domain timing %#", (input, field) => {
    expect(validateSceneTiming(input)).toMatchObject({ code: ErrorCode.TimingInvalid, field });
  });

  it("rejects a scene that overflows the root duration", () => {
    expect(validateSceneTiming({ start: 3, duration: 3, trackIndex: 0, rootDuration: 5 })).toMatchObject({
      code: ErrorCode.DurationOverflow,
      field: "duration",
    });
  });
});

describe("multi-track ripple invariants", () => {
  const scenes = [
    { sceneId: "a", start: 0, duration: 2, trackIndex: 0 },
    { sceneId: "b", start: 2, duration: 2, trackIndex: 0 },
    { sceneId: "overlay", start: 1, duration: 6, trackIndex: 1 },
  ];

  it("moves only later scenes in the target track and computes root duration across all tracks", () => {
    expect(planRipple(scenes, { sceneId: "a", duration: 4 })).toEqual({
      ok: true,
      value: {
        trackIndex: 0,
        moved: [{ sceneId: "b", fromStart: 2, toStart: 4 }],
        rootDuration: 7,
      },
    });
  });

  it("does not diagnose intentional cross-track overlap", () => {
    expect(detectTrackGapsAndOverlaps(scenes)).toEqual([]);
    expect(detectTrackGapsAndOverlaps([
      ...scenes,
      { sceneId: "c", start: 5, duration: 1, trackIndex: 0 },
    ])).toMatchObject([{ code: "track-gap", sceneId: "c" }]);
  });
});
