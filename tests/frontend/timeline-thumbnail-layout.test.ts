// @vitest-environment node

import { describe, expect, it } from "vitest";

import { planTimelineThumbnailCells } from "@/lib/studio/timeline-thumbnail-layout";

describe("timeline thumbnail layout", () => {
  it("uses one cell per 80 clip pixels and samples scene-local centers", () => {
    const cells = planTimelineThumbnailCells({
      sceneStartSeconds: 6,
      durationSeconds: 2,
      pixelsPerSecond: 80,
      viewportStartPx: 0,
      viewportWidthPx: 2_000,
    });
    expect(cells).toEqual([
      { index: 0, count: 2, leftPx: 0, widthPx: 80, atSeconds: 0.5 },
      { index: 1, count: 2, leftPx: 80, widthPx: 80, atSeconds: 1.5 },
    ]);
  });

  it("recomputes density and center marks when zoom changes", () => {
    const base = {
      sceneStartSeconds: 0,
      durationSeconds: 2,
      viewportStartPx: 0,
      viewportWidthPx: 2_000,
    };
    expect(planTimelineThumbnailCells({ ...base, pixelsPerSecond: 80 }).map((cell) => cell.atSeconds))
      .toEqual([0.5, 1.5]);
    expect(planTimelineThumbnailCells({ ...base, pixelsPerSecond: 160 }).map((cell) => cell.atSeconds))
      .toEqual([0.25, 0.75, 1.25, 1.75]);
    expect(planTimelineThumbnailCells({
      ...base, durationSeconds: 1, pixelsPerSecond: 81,
    }).map((cell) => cell.count)).toEqual([2, 2]);
  });

  it("virtualizes individual cells to the viewport plus one viewport on each side", () => {
    const cells = planTimelineThumbnailCells({
      sceneStartSeconds: 0,
      durationSeconds: 100,
      pixelsPerSecond: 80,
      viewportStartPx: 3_000,
      viewportWidthPx: 800,
    });
    expect(cells).toHaveLength(31);
    expect(cells[0]).toMatchObject({ index: 27, count: 100, leftPx: 2_160, widthPx: 80 });
    expect(cells.at(-1)).toMatchObject({ index: 57, count: 100, leftPx: 4_560, widthPx: 80 });
    expect(cells.every((cell) => cell.leftPx + cell.widthPx >= 2_200 && cell.leftPx <= 4_600)).toBe(true);
  });

  it("keeps a stable single placeholder cell for narrow valid clips", () => {
    expect(planTimelineThumbnailCells({
      sceneStartSeconds: 1,
      durationSeconds: 0.2,
      pixelsPerSecond: 20,
      viewportStartPx: 0,
      viewportWidthPx: 500,
    })).toEqual([{ index: 0, count: 1, leftPx: 0, widthPx: 4, atSeconds: 0.1 }]);
  });
});
