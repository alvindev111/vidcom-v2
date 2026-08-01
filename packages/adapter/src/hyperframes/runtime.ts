import { getHyperframeRuntimeScript } from "@hyperframes/core";

/** Returns the pinned HyperFrames browser runtime without exposing the SDK to transports. */
export function hyperframesRuntimeSource(): string {
  return getHyperframeRuntimeScript();
}
