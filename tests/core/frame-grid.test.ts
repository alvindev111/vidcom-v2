import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import { FrameGrid } from "@vidcom/core";

describe("FrameGrid", () => {
  it("validates integer and rational frame rates without normalizing input", () => {
    const integer = FrameGrid.fromFps(30);
    expect(integer.isAligned(2.5)).toBe(true);
    expect(integer.isAligned(2.55)).toBe(false);

    const ntsc = FrameGrid.fromRate({ numerator: 30_000, denominator: 1_001 });
    expect(ntsc.isAligned((1_001 * 77) / 30_000)).toBe(true);
    expect(ntsc.isAligned(2.55)).toBe(false);
  });

  it("returns the public typed error with field, value and fps", () => {
    expect(FrameGrid.fromFps(30).validate(2.55, "start")).toEqual({
      code: ErrorCode.TimingNotFrameAligned,
      message: "start must align to the project frame grid",
      field: "start",
      details: { value: 2.55, fps: 30 },
    });
  });
});
