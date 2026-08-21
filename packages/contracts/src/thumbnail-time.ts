/** Selects one stable scene-local frame after the entrance and before the final hold. */
export function representativeSceneTime(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new TypeError("representative thumbnail inputs are invalid");
  }
  if (duration === 0) return 0;
  const lastFrame = Math.max(0, (Math.ceil(duration * fps) - 1) / fps);
  return Math.min(lastFrame, Math.round(duration * 0.55 * fps) / fps);
}
