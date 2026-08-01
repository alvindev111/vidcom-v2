import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import { validateSceneTiming } from "@vidcom/core";

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
