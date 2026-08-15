import { describe, expect, it } from "vitest";

import type { SceneDto } from "@vidcom/contracts";
import { storyMotionDiagnostic } from "@vidcom/core";

function scene(effects: SceneDto["elements"][number]["effects"], overrides: Partial<SceneDto> = {}): SceneDto {
  return {
    id: "story-beat",
    src: "compositions/story-beat.html",
    start: 0,
    duration: 4,
    trackIndex: 0,
    block: null,
    isTransition: false,
    media: [],
    script: [],
    narration: null,
    elements: [{
      id: "hero",
      label: "hero",
      kind: "element",
      start: null,
      duration: null,
      src: null,
      effects,
    }],
    unresolvedEffects: 0,
    ...overrides,
  };
}

describe("story motion gate", () => {
  it("rejects an empty or fade-and-rise-only story scene", () => {
    expect(storyMotionDiagnostic(scene([]))).toMatchObject({ severity: "error", code: "story-motion-shallow" });
    expect(storyMotionDiagnostic(scene([
      { id: "fade", method: "fromTo", start: 0.2, duration: 0.4, ease: "power2.out", propertyGroup: "visual" },
      { id: "rise", method: "fromTo", start: 0.2, duration: 0.4, ease: "power2.out", propertyGroup: "position" },
    ]))).toMatchObject({ severity: "error", code: "story-motion-shallow" });
    expect(storyMotionDiagnostic(scene([
      { id: "single-scale", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
    ]))).toMatchObject({ severity: "error", code: "story-motion-shallow" });
    expect(storyMotionDiagnostic(scene([
      { id: "scale", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
      { id: "fade", method: "to", start: 1.4, duration: 0.4, ease: "sine.out", propertyGroup: "visual" },
    ]))).toMatchObject({ severity: "error", code: "story-motion-shallow" });
    expect(storyMotionDiagnostic(scene([
      { id: "size", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "size" },
      { id: "resize", method: "to", start: 1.4, duration: 0.4, ease: "sine.out", propertyGroup: "size" },
    ]))).toMatchObject({ severity: "error", code: "story-motion-shallow" });
    expect(storyMotionDiagnostic(scene([
      { id: "scale", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
      { id: "rotate", method: "to", start: 0.201, duration: 0.8, ease: "sine.inOut", propertyGroup: "rotation" },
    ]))).toMatchObject({ severity: "error", code: "story-motion-shallow" });
  });

  it("accepts a visible non-trivial transformation", () => {
    expect(storyMotionDiagnostic(scene([
      { id: "build", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
      { id: "payoff", method: "to", start: 1.4, duration: 0.8, ease: "sine.inOut", propertyGroup: "rotation" },
    ]))).toBeNull();
  });

  it("does not gate transitions but fails closed on runtime-dynamic selectors", () => {
    expect(storyMotionDiagnostic(scene([], { isTransition: true }))).toBeNull();
    expect(storyMotionDiagnostic(scene([], { unresolvedEffects: 1 })))
      .toMatchObject({ severity: "error", code: "story-motion-unverified" });
    expect(storyMotionDiagnostic(scene([
      { id: "build", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
      { id: "payoff", method: "to", start: 1.4, duration: 0.8, ease: "sine.inOut", propertyGroup: "rotation" },
    ], { unresolvedEffects: 1 }))).toMatchObject({ severity: "error", code: "story-motion-unverified" });
  });
});
