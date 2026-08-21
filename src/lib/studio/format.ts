/**
 * `m:ss.ff` when a frame rate is given, `m:ss` when it is not (R8.3).
 *
 * `ff` is the frame **inside** the second — `floor((seconds % 1) * fps)` — not
 * hundredths: at 30 fps `0:07.13` is frame 13 of second 7, and two neighbouring
 * frames must read differently or the number is decoration. The frame is padded
 * to as many digits as the rate needs, so 120 fps reads `0:01.060`.
 *
 * The rate is optional because most places that show time — a scene range, a
 * ruler tick — are naming a position, not a frame, and there the plain clock is
 * what the timeline has always shown.
 */
export function formatTimecode(seconds: number, fps?: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = Math.floor(clamped % 60);
  const clock = `${minutes}:${String(rest).padStart(2, "0")}`;
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) return clock;
  const digits = String(Math.ceil(fps) - 1).length;
  const frame = Math.min(Math.floor((clamped % 1) * fps), Math.ceil(fps) - 1);
  return `${clock}.${String(frame).padStart(digits, "0")}`;
}

/** Position of `seconds` within a composition, as a CSS percentage string. */
export function toPercent(seconds: number, duration: number): string {
  if (duration <= 0) return "0%";
  return `${(seconds / duration) * 100}%`;
}
