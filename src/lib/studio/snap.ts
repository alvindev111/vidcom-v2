export interface SnapCandidate {
  time: number;
  kind: "clip-edge" | "playhead" | "ruler";
  id: string;
}

export interface SnapResult {
  time: number;
  candidate: SnapCandidate | null;
}

/** Converts the visible eight-pixel magnet range to time without losing either zoom extreme. */
export function snapToleranceSeconds(pixelsPerSecond: number, fps: number): number {
  const frame = 1 / fps;
  return Math.min(0.5, Math.max(frame, 8 / pixelsPerSecond));
}

/** Returns the closest eligible marker; equal-distance markers keep their authored priority. */
export function snapTime(
  time: number,
  candidates: readonly SnapCandidate[],
  tolerance: number,
): SnapResult {
  let candidate: SnapCandidate | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const current of candidates) {
    const currentDistance = Math.abs(current.time - time);
    if (currentDistance <= tolerance && currentDistance < distance) {
      candidate = current;
      distance = currentDistance;
    }
  }
  return candidate ? { time: candidate.time, candidate } : { time, candidate: null };
}

export function roundToFrame(time: number, fps: number): number {
  const rounded = Math.round(time * fps) / fps;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Splits one clip into two bounded edge handles and a body that never disappears. */
export function hitZone(
  offsetX: number,
  clipWidthPx: number,
): "body" | "trim-start" | "trim-end" {
  const edgeWidth = Math.min(8, clipWidthPx * 0.4);
  if (offsetX < edgeWidth) return "trim-start";
  if (offsetX >= clipWidthPx - edgeWidth) return "trim-end";
  return "body";
}
