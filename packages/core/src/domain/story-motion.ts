import type { Diagnostic, SceneDto } from "@vidcom/contracts";

const MEANINGFUL_MOTION_GROUPS = new Set(["scale", "rotation", "other"]);
const MIN_PHASE_GAP_SECONDS = 0.1;
const MIN_STORY_DURATION_SECONDS = 6;
const MAX_STORY_DURATION_SECONDS = 10;
const MIN_NARRATION_COVERAGE = 0.75;

export interface StoryMotionProfile {
  sceneId: string;
  role: SceneDto["role"];
  duration: number;
  pattern: string | null;
  seam: { kind: "carry" | "transform" | "contrast"; token: string } | null;
  phaseStarts: number[];
  meaningfulGroups: string[];
  unresolvedEffects: number;
  narrationSeconds: number;
}

function distinctPhaseStarts(starts: readonly number[]): number[] {
  const sorted = [...starts].sort((left, right) => left - right);
  return sorted.filter((start, index) => index === 0
    || start - sorted[index - 1]! >= MIN_PHASE_GAP_SECONDS);
}

/** Projects only statically verified, scene-local evidence used by every story gate. */
export function storyMotionProfile(scene: SceneDto): StoryMotionProfile {
  const effects = scene.elements.flatMap((element) => element.effects)
    .filter((effect) => effect.duration > 0 && effect.start >= 0 && effect.start < scene.duration);
  const narrationSeconds = scene.narration?.status === "generated"
      && scene.narration.staleSince === null
      && scene.narration.durationSeconds !== undefined
    ? Math.min(scene.duration, scene.narration.durationSeconds)
    : 0;
  return {
    sceneId: scene.id,
    role: scene.role,
    duration: scene.duration,
    pattern: scene.storyPattern ?? null,
    seam: scene.seam ?? null,
    phaseStarts: distinctPhaseStarts(effects.map(({ start }) => start)),
    meaningfulGroups: effects
      .filter(({ propertyGroup }) => propertyGroup !== null && MEANINGFUL_MOTION_GROUPS.has(propertyGroup))
      .map(({ propertyGroup }) => propertyGroup!),
    unresolvedEffects: scene.unresolvedEffects,
    narrationSeconds,
  };
}

function hasThreePhaseEvidence(scene: SceneDto): boolean {
  if (!(scene.duration > 0)) return false;
  const profile = storyMotionProfile(scene);
  const firstBoundary = scene.duration / 3;
  const finalBoundary = firstBoundary * 2;
  const coversThirds = profile.phaseStarts.some((start) => start < firstBoundary)
    && profile.phaseStarts.some((start) => start >= firstBoundary && start < finalBoundary)
    && profile.phaseStarts.some((start) => start >= finalBoundary && start < scene.duration);
  const meaningfulPhases = distinctPhaseStarts(scene.elements.flatMap((element) => element.effects)
    .filter((effect) => effect.duration > 0
      && effect.propertyGroup !== null
      && MEANINGFUL_MOTION_GROUPS.has(effect.propertyGroup))
    .map(({ start }) => start));
  return coversThirds && meaningfulPhases.length >= 2;
}

/** Rejects a story scene that cannot prove setup, development and payoff. */
export function storyMotionDiagnostic(scene: SceneDto): Diagnostic | null {
  if (scene.isTransition || scene.role !== "story") return null;
  const effects = scene.elements.flatMap((element) => element.effects);
  if (scene.unresolvedEffects === 0 && hasThreePhaseEvidence(scene)) return null;
  return {
    severity: "error",
    code: scene.unresolvedEffects > 0 ? "story-motion-unverified" : "story-motion-shallow",
    sceneId: scene.id,
    message: scene.unresolvedEffects > 0
      ? "Story motion could not be verified statically. Resolve dynamic selectors and keep setup, development and payoff scene-local before rendering."
      : effects.length === 0
        ? "Story scene has no statically resolvable choreography. Add setup, development, payoff, and hold before rendering."
        : "Story scene does not prove meaningful setup, development and payoff across its first, middle and final thirds.",
  };
}

function mergedDuration(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(([start, end]) => [start, end] as const)
    .sort(([left], [right]) => left - right);
  let duration = 0;
  let activeStart: number | null = null;
  let activeEnd = 0;
  for (const [start, end] of sorted) {
    if (activeStart === null) {
      activeStart = start;
      activeEnd = end;
    } else if (start <= activeEnd) {
      activeEnd = Math.max(activeEnd, end);
    } else {
      duration += activeEnd - activeStart;
      activeStart = start;
      activeEnd = end;
    }
  }
  return activeStart === null ? 0 : duration + activeEnd - activeStart;
}

function repeatedPatternAllowed(previous: StoryMotionProfile, current: StoryMotionProfile): boolean {
  return previous.pattern !== null
    && previous.pattern === current.pattern
    && previous.seam !== null
    && current.seam !== null
    && previous.seam.token === current.seam.token
    && (current.seam.kind === "carry" || current.seam.kind === "transform");
}

/** Runs scene, sequence, pacing, seam and narration gates from one shared projection. */
export function storyCompositionDiagnostics(
  scenes: readonly SceneDto[],
  options: { strictAgentStory: boolean },
): Diagnostic[] {
  const storyScenes = scenes.filter((scene) => scene.role === "story" && !scene.isTransition);
  const profiles = storyScenes.map(storyMotionProfile);
  const diagnostics = storyScenes.flatMap((scene) => {
    const motion = storyMotionDiagnostic(scene);
    const findings: Diagnostic[] = motion ? [motion] : [];
    if (!scene.storyPattern) findings.push({
      severity: options.strictAgentStory ? "error" : "warning",
      code: "story-metadata-missing",
      sceneId: scene.id,
      message: options.strictAgentStory
        ? "Agent-kit v9 story scene requires a bounded data-story-pattern."
        : "Legacy story scene has no story pattern metadata; motion is still checked.",
    });
    return findings;
  });

  if (!options.strictAgentStory) return diagnostics;

  for (const [index, profile] of profiles.entries()) {
    const hasLateStateChange = profile.phaseStarts.some((start) => start >= profile.duration / 3);
    if (profile.duration > MAX_STORY_DURATION_SECONDS
      && (profile.narrationSeconds === 0 || !hasLateStateChange)) diagnostics.push({
      severity: "error",
      code: "story-scene-static-too-long",
      sceneId: profile.sceneId,
      message: "A story scene over 10 seconds requires current generated narration and a verified state change that continues through its middle or final third.",
    });
    if (profile.duration < MIN_STORY_DURATION_SECONDS || profile.duration > MAX_STORY_DURATION_SECONDS) {
      diagnostics.push({
        severity: "error",
        code: "story-scene-duration",
        sceneId: profile.sceneId,
        message: `Generated story scene must be ${MIN_STORY_DURATION_SECONDS}–${MAX_STORY_DURATION_SECONDS} seconds; received ${profile.duration}.`,
      });
    }
    if (index > 0 && profile.seam === null) diagnostics.push({
      severity: "error",
      code: "story-seam-missing",
      sceneId: profile.sceneId,
      message: "Every generated story scene after the first requires a concrete carry, transform or contrast seam token.",
    });
    const previous = profiles[index - 1];
    if (previous?.pattern !== null && previous?.pattern === profile.pattern
      && !repeatedPatternAllowed(previous, profile)) diagnostics.push({
      severity: "error",
      code: "story-pattern-repeated",
      sceneId: profile.sceneId,
      message: "Adjacent story scenes repeat a primary pattern without a matching visible carry or transform seam.",
      details: { previousSceneId: previous.sceneId, pattern: profile.pattern },
    });
  }

  for (let index = 0; index + 4 <= profiles.length; index += 1) {
    const window = profiles.slice(index, index + 4);
    if (new Set(window.map(({ pattern }) => pattern).filter(Boolean)).size < 3) diagnostics.push({
      severity: "error",
      code: "story-pattern-diversity",
      sceneId: window.at(-1)?.sceneId,
      message: "Every rolling four story scenes require at least three primary story patterns.",
      details: { sceneIds: window.map(({ sceneId }) => sceneId) },
    });
  }

  const storyDuration = mergedDuration(storyScenes.map((scene) => [scene.start, scene.start + scene.duration]));
  const narrationDuration = mergedDuration(storyScenes.flatMap((scene, index) => {
    const seconds = profiles[index]!.narrationSeconds;
    return seconds > 0 ? [[scene.start, scene.start + seconds] as const] : [];
  }));
  const coverage = storyDuration === 0 ? 1 : narrationDuration / storyDuration;
  if (coverage < MIN_NARRATION_COVERAGE) diagnostics.push({
    severity: "error",
    code: "story-narration-sparse",
    message: `Generated narration covers ${(coverage * 100).toFixed(1)}% of story time; at least 75% is required.`,
    details: { coverage, narrationSeconds: narrationDuration, storySeconds: storyDuration },
  });
  return diagnostics;
}

/** Compatibility helper for callers that only need per-scene motion blocking. */
export function storyMotionDiagnostics(scenes: readonly SceneDto[]): Diagnostic[] {
  return scenes.flatMap((scene) => {
    const diagnostic = storyMotionDiagnostic(scene);
    return diagnostic ? [diagnostic] : [];
  });
}
