export interface TimelineThumbnailCell {
  index: number;
  count: number;
  leftPx: number;
  widthPx: number;
  /** Scene-local center mark sent to Core; scene start is never added. */
  atSeconds: number;
}

export interface TimelineThumbnailViewport {
  startPx: number;
  widthPx: number;
}

const CELL_TARGET_PX = 80;

/** Selects individual cells intersecting the viewport plus one viewport on each side. */
export function planTimelineThumbnailCells(input: {
  sceneStartSeconds: number;
  durationSeconds: number;
  pixelsPerSecond: number;
  viewportStartPx: number;
  viewportWidthPx: number;
}): TimelineThumbnailCell[] {
  if (![input.sceneStartSeconds, input.durationSeconds, input.pixelsPerSecond,
    input.viewportStartPx, input.viewportWidthPx].every(Number.isFinite)
    || input.sceneStartSeconds < 0 || input.durationSeconds <= 0 || input.pixelsPerSecond <= 0
    || input.viewportStartPx < 0 || input.viewportWidthPx <= 0) return [];
  const clipWidthPx = input.durationSeconds * input.pixelsPerSecond;
  const count = Math.max(1, Math.ceil(clipWidthPx / CELL_TARGET_PX));
  const widthPx = clipWidthPx / count;
  const clipLeftPx = input.sceneStartSeconds * input.pixelsPerSecond;
  const windowStartPx = Math.max(0, input.viewportStartPx - input.viewportWidthPx);
  const windowEndPx = input.viewportStartPx + input.viewportWidthPx * 2;
  const cells: TimelineThumbnailCell[] = [];
  for (let index = 0; index < count; index += 1) {
    const leftPx = index * widthPx;
    const globalLeftPx = clipLeftPx + leftPx;
    if (globalLeftPx + widthPx < windowStartPx || globalLeftPx > windowEndPx) continue;
    cells.push({
      index,
      count,
      leftPx,
      widthPx,
      atSeconds: ((index + 0.5) * input.durationSeconds) / count,
    });
  }
  return cells;
}
