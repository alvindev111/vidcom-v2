/** `0:07` — the timecode format used by the playback bar and the timeline ruler. */
export function formatTimecode(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = Math.floor(clamped % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** Position of `seconds` within a composition, as a CSS percentage string. */
export function toPercent(seconds: number, duration: number): string {
  if (duration <= 0) return "0%";
  return `${(seconds / duration) * 100}%`;
}
