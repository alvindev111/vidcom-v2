import { ErrorCode, type DomainError } from "@vidcom/contracts";

/** Timing values whose business invariants are checked by Core. */
export interface SceneTimingInput {
  start: number;
  duration: number;
  trackIndex: number;
  rootDuration: number;
}

/** Returns the first timing invariant failure, or `null` when the timing is valid. */
export function validateSceneTiming(input: SceneTimingInput): DomainError | null {
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    return {
      code: ErrorCode.TimingInvalid,
      message: "duration must be greater than zero",
      field: "duration",
    };
  }
  if (!Number.isFinite(input.start) || input.start < 0) {
    return {
      code: ErrorCode.TimingInvalid,
      message: "start must be zero or greater",
      field: "start",
    };
  }
  if (!Number.isInteger(input.trackIndex)) {
    return {
      code: ErrorCode.TimingInvalid,
      message: "trackIndex must be an integer",
      field: "trackIndex",
    };
  }
  const end = input.start + input.duration;
  if (!Number.isFinite(end) || end > input.rootDuration) {
    return {
      code: ErrorCode.DurationOverflow,
      message: "scene timing exceeds the root duration",
      field: "duration",
    };
  }
  return null;
}
