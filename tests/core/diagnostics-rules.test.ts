import { describe, expect, it } from "vitest";

import { countStrandedTweens, measureElementWindow } from "@vidcom/core";

describe("diagnostic timing rules", () => {
  const element = {
    id: "hero",
    start: 1,
    duration: 5,
    effects: [
      { id: "visible", start: 2, duration: 1 },
      { id: "stranded", start: 4, duration: 1 },
    ],
  };

  it("keeps stranded tween and element-overrun arithmetic in one Core source", () => {
    expect(countStrandedTweens([element], 4)).toBe(1);
    expect(measureElementWindow(element, 4)).toMatchObject({
      start: 1,
      span: 5,
      inWindow: 3,
      overrun: 2,
    });
  });
});

