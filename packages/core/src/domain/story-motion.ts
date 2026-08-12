import type { Diagnostic, SceneDto } from "@vidcom/contracts";

const MEANINGFUL_MOTION_GROUPS = new Set(["scale", "rotation", "other"]);
const MIN_PHASE_GAP_SECONDS = 0.1;

/**
 * Rejects story scenes whose statically visible choreography is only transition polish.
 *
 * The parser deliberately exposes property groups instead of raw author source here.
 * A position tween alone is the common fade/rise/slide recipe, while scale, rotation,
 * structural/other changes across distinct phases are evidence of a scene that
 * develops and lands a visible state. Dynamic selectors fail closed because a
 * render gate must not guess that unparsed runtime work is meaningful motion.
 */
export function storyMotionDiagnostic(scene: SceneDto): Diagnostic | null {
  if (scene.isTransition) return null;

  const effects = scene.elements.flatMap((element) => element.effects);
  const meaningfulStarts = effects
    .filter((effect) => effect.duration > 0
      && effect.propertyGroup !== null
      && MEANINGFUL_MOTION_GROUPS.has(effect.propertyGroup))
    .map((effect) => effect.start)
    .sort((left, right) => left - right);
  const hasSeparatedPhases = meaningfulStarts.some((start, index) => index > 0
    && start - meaningfulStarts[index - 1]! >= MIN_PHASE_GAP_SECONDS);

  if (scene.unresolvedEffects === 0 && hasSeparatedPhases) return null;
  return {
    severity: "error",
    code: scene.unresolvedEffects > 0 ? "story-motion-unverified" : "story-motion-shallow",
    sceneId: scene.id,
    message: scene.unresolvedEffects > 0
      ? "Story motion could not be verified statically. Resolve dynamic selectors or add a statically verifiable meaningful state change before rendering."
      : effects.length === 0
      ? "Story scene has no statically resolvable choreography. Add setup, development, payoff, and hold before rendering."
      : "Story scene lacks verified multi-phase motion or relies only on fade/position polish. Add a meaningful state change across at least two phases before rendering.",
  };
}

/** Returns blocking story-motion diagnostics for every non-transition scene. */
export function storyMotionDiagnostics(scenes: readonly SceneDto[]): Diagnostic[] {
  return scenes.flatMap((scene) => {
    const diagnostic = storyMotionDiagnostic(scene);
    return diagnostic ? [diagnostic] : [];
  });
}
