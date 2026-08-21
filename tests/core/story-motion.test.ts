import { describe, expect, it } from "vitest";

import type { SceneDto } from "@vidcom/contracts";
import {
  storyCompositionDiagnostics,
  storyMotionDiagnostic,
  storyMotionProfile,
} from "@vidcom/core";

function scene(effects: SceneDto["elements"][number]["effects"], overrides: Partial<SceneDto> = {}): SceneDto {
  return {
    id: "story-beat",
    src: "compositions/story-beat.html",
    sourceFile: "compositions/story-beat.html",
    role: "story",
    start: 0,
    duration: 9,
    trackIndex: 0,
    block: null,
    isTransition: false,
    media: [],
    script: [],
    narration: null,
    elements: [{
      id: "hero",
      authoredId: "hero",
      label: "hero",
      kind: "element",
      start: null,
      duration: null,
      src: null,
      layoutOffset: null,
      positionEditable: true,
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
      { id: "develop", method: "to", start: 3.2, duration: 0.8, ease: "sine.inOut", propertyGroup: "other" },
      { id: "payoff", method: "to", start: 6.2, duration: 0.8, ease: "sine.inOut", propertyGroup: "rotation" },
    ]))).toBeNull();
  });

  it("does not gate transitions but fails closed on runtime-dynamic selectors", () => {
    expect(storyMotionDiagnostic(scene([], { isTransition: true }))).toBeNull();
    expect(storyMotionDiagnostic(scene([], { unresolvedEffects: 1 })))
      .toMatchObject({ severity: "error", code: "story-motion-unverified" });
    expect(storyMotionDiagnostic(scene([
      { id: "build", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
      { id: "develop", method: "to", start: 3.2, duration: 0.8, ease: "sine.inOut", propertyGroup: "other" },
      { id: "payoff", method: "to", start: 6.2, duration: 0.8, ease: "sine.inOut", propertyGroup: "rotation" },
    ], { unresolvedEffects: 1 }))).toMatchObject({ severity: "error", code: "story-motion-unverified" });
  });

  it("extracts setup, development and payoff evidence from all three scene thirds", () => {
    const input = scene([
      { id: "setup", method: "fromTo", start: 0.4, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
      { id: "develop", method: "to", start: 3.4, duration: 0.8, ease: "sine.inOut", propertyGroup: "other" },
      { id: "payoff", method: "to", start: 6.5, duration: 0.8, ease: "back.out", propertyGroup: "rotation" },
    ], {
      storyPattern: "state-transformation",
      seam: { kind: "transform", token: "red-thread" },
    });
    expect(storyMotionProfile(input)).toEqual({
      sceneId: "story-beat",
      role: "story",
      duration: 9,
      pattern: "state-transformation",
      seam: { kind: "transform", token: "red-thread" },
      phaseStarts: [0.4, 3.4, 6.5],
      meaningfulGroups: ["scale", "other", "rotation"],
      unresolvedEffects: 0,
      narrationSeconds: 0,
    });
    expect(storyMotionDiagnostic(input)).toBeNull();
  });

  it("rejects three entrances crowded into setup even when their property groups look meaningful", () => {
    expect(storyMotionDiagnostic(scene([
      { id: "setup", method: "fromTo", start: 0.2, duration: 0.5, ease: null, propertyGroup: "scale" },
      { id: "also-setup", method: "to", start: 0.6, duration: 0.5, ease: null, propertyGroup: "other" },
      { id: "still-setup", method: "to", start: 1.1, duration: 0.5, ease: null, propertyGroup: "rotation" },
    ]))).toMatchObject({ severity: "error", code: "story-motion-shallow" });
  });

  it("enforces strict duration, seams, rolling-four diversity and narration coverage", () => {
    const motion = [
      { id: "setup", method: "fromTo", start: 0.3, duration: 0.5, ease: null, propertyGroup: "scale" },
      { id: "develop", method: "to", start: 3.2, duration: 0.5, ease: null, propertyGroup: "other" },
      { id: "payoff", method: "to", start: 6.1, duration: 0.5, ease: null, propertyGroup: "rotation" },
    ];
    const scenes = ["diagram-build", "state-transform", "camera-reveal", "diagram-build"].map((pattern, index) => scene(motion, {
      id: `scene-${index + 1}`,
      start: index * 9,
      storyPattern: pattern,
      seam: index === 0 ? null : { kind: "contrast", token: `handoff-${index}` },
      narration: index < 2 ? {
        sceneId: `scene-${index + 1}`,
        text: "Lời kể",
        voice: "vi",
        status: "generated",
        audioPath: `narration/scene-${index + 1}.wav`,
        command: "tts",
        revision: 1,
        updatedAt: "2026-08-22T00:00:00.000Z",
        staleSince: null,
        durationSeconds: 8,
      } : null,
    }));
    expect(storyCompositionDiagnostics(scenes, { strictAgentStory: true }).map(({ code }) => code))
      .toContain("story-narration-sparse");

    scenes[1] = { ...scenes[1]!, storyPattern: "diagram-build", seam: null };
    const codes = storyCompositionDiagnostics(scenes, { strictAgentStory: true }).map(({ code }) => code);
    expect(codes).toContain("story-seam-missing");
    expect(codes).toContain("story-pattern-repeated");

    scenes[0] = { ...scenes[0]!, duration: 15 };
    expect(storyCompositionDiagnostics(scenes, { strictAgentStory: true }).map(({ code }) => code))
      .toContain("story-scene-duration");
  });

  it("warns for missing v9 metadata on legacy projects while retaining the shallow error", () => {
    const validLegacy = scene([
      { id: "setup", method: "fromTo", start: 0.3, duration: 0.5, ease: null, propertyGroup: "scale" },
      { id: "develop", method: "to", start: 3.2, duration: 0.5, ease: null, propertyGroup: "other" },
      { id: "payoff", method: "to", start: 6.1, duration: 0.5, ease: null, propertyGroup: "rotation" },
    ]);
    expect(storyCompositionDiagnostics([validLegacy], { strictAgentStory: false }))
      .toEqual([expect.objectContaining({ severity: "warning", code: "story-metadata-missing" })]);
    expect(storyCompositionDiagnostics([scene([])], { strictAgentStory: false }).map(({ code }) => code))
      .toEqual(expect.arrayContaining(["story-motion-shallow", "story-metadata-missing"]));
  });

  it("blocks an 18-scene repeated static loop and passes only after pacing, diversity and coverage repair", () => {
    const repeated = Array.from({ length: 18 }, (_, index) => scene([
      { id: "fade", method: "fromTo", start: 0.2, duration: 0.5, ease: null, propertyGroup: "visual" },
      { id: "rise", method: "fromTo", start: 0.2, duration: 0.5, ease: null, propertyGroup: "position" },
    ], {
      id: `s${String(index + 1).padStart(2, "0")}`,
      start: index * 15,
      duration: 15,
      storyPattern: "repeated-loop",
      seam: index === 0 ? null : { kind: "contrast", token: "same-loop" },
    }));
    const blocked = storyCompositionDiagnostics(repeated, { strictAgentStory: true });
    expect(new Set(blocked.filter(({ code }) => code === "story-motion-shallow").map(({ sceneId }) => sceneId)).size)
      .toBe(18);
    expect(blocked.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "story-scene-static-too-long",
      "story-scene-duration",
      "story-pattern-repeated",
      "story-pattern-diversity",
      "story-narration-sparse",
    ]));

    const patterns = ["diagram-build", "state-transform", "camera-reveal", "object-journey"];
    const repaired = repeated.map((item, index): SceneDto => ({
      ...item,
      start: index * 8.5,
      duration: 8.5,
      storyPattern: patterns[index % patterns.length],
      seam: index === 0 ? null : { kind: index % 2 ? "transform" : "contrast", token: `token-${index}` },
      narration: {
        sceneId: item.id,
        text: "Lời kể đầy đủ cho nhịp truyện.",
        voice: "vi",
        status: "generated",
        audioPath: `narration/${item.id}.wav`,
        command: "tts",
        revision: 1,
        updatedAt: "2026-08-22T00:00:00.000Z",
        staleSince: null,
        durationSeconds: 7,
      },
      elements: [{
        ...item.elements[0]!,
        effects: [
          { id: "setup", method: "fromTo", start: 0.3, duration: 0.5, ease: null, propertyGroup: "scale" },
          { id: "develop", method: "to", start: 3, duration: 0.5, ease: null, propertyGroup: "other" },
          { id: "payoff", method: "to", start: 5.9, duration: 0.5, ease: null, propertyGroup: "rotation" },
        ],
      }],
    }));
    expect(storyCompositionDiagnostics(repaired, { strictAgentStory: true })).toEqual([]);
  });
});
