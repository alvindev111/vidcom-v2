// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  hitZone,
  roundToFrame,
  snapTime,
  snapToleranceSeconds,
  type SnapCandidate,
} from "../../src/lib/studio/snap";

describe("timeline snap geometry", () => {
  it("keeps the eight-pixel tolerance between one frame and half a second", () => {
    expect(snapToleranceSeconds(8, 30)).toBe(0.5);
    expect(snapToleranceSeconds(80, 30)).toBe(0.1);
    expect(snapToleranceSeconds(480, 30)).toBeCloseTo(1 / 30);
  });

  it("rounds free timing to the nearest renderable frame", () => {
    expect(roundToFrame(1.01, 30)).toBe(1);
    expect(roundToFrame(1.02, 30)).toBeCloseTo(31 / 30);
  });

  it("chooses the nearest in-range candidate and preserves its identity", () => {
    const candidates: SnapCandidate[] = [
      { time: 1, kind: "ruler", id: "second-1" },
      { time: 1.08, kind: "clip-edge", id: "scene-b:start" },
    ];
    expect(snapTime(1.06, candidates, 0.05, 30)).toEqual({
      time: 32 / 30,
      candidate: { ...candidates[1], time: 32 / 30 },
    });
    expect(snapTime(1.21, candidates, 0.01, 30)).toEqual({ time: 36 / 30, candidate: null });
  });

  it("leaves a draggable body between capped edge zones on a 20px clip", () => {
    expect(hitZone(7.9, 20)).toBe("trim-start");
    expect(hitZone(8, 20)).toBe("body");
    expect(hitZone(11.9, 20)).toBe("body");
    expect(hitZone(12, 20)).toBe("trim-end");
    expect(hitZone(3.9, 10)).toBe("trim-start");
    expect(hitZone(4, 10)).toBe("body");
  });
});
