// @vitest-environment node

import { describe, expect, it } from "vitest";

import { planCanvasDrag } from "../../src/lib/studio/canvas-drag";

describe("canvas drag planner", () => {
  const input = {
    pointerStart: { x: 100, y: 100 },
    viewport: { x: 0, y: 0, width: 960, height: 540 },
    canvas: { width: 1920, height: 1080 },
    targetRect: { x: 100, y: 100, width: 400, height: 200 },
    existingOffset: { x: 0, y: 0 },
    snap: false,
  } as const;

  it("converts CSS-pixel pointer movement to authored canvas coordinates", () => {
    expect(planCanvasDrag({ ...input, pointerNow: { x: 116, y: 92 } })).toMatchObject({
      offsetX: 32,
      offsetY: -16,
      absoluteX: 132,
      absoluteY: 84,
      changed: true,
    });
  });

  it("snaps by eight screen pixels independently of zoom and device pixel ratio", () => {
    expect(planCanvasDrag({ ...input, pointerNow: { x: 113, y: 113 }, snap: true })).toMatchObject({
      offsetX: 32,
      offsetY: 32,
    });
    expect(planCanvasDrag({
      ...input,
      viewport: { x: 0, y: 0, width: 480, height: 270 },
      pointerNow: { x: 113, y: 113 },
      snap: true,
    })).toMatchObject({ offsetX: 64, offsetY: 64 });
  });

  it("clamps the full target rect inside the composition and identifies no-op", () => {
    expect(planCanvasDrag({ ...input, pointerNow: { x: -500, y: -500 } })).toMatchObject({
      offsetX: -100,
      offsetY: -100,
      absoluteX: 0,
      absoluteY: 0,
      changed: true,
    });
    expect(planCanvasDrag({ ...input, pointerNow: input.pointerStart })).toMatchObject({
      offsetX: 0,
      offsetY: 0,
      changed: false,
    });
  });
});
