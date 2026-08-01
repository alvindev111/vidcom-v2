import { groupOf } from "./snapshots";
import type { Scene } from "./types";

export interface OrderedScene {
  scene: Scene;
  /** Storyboard position, 1-based — the number shown on the card and the lane. */
  index: number;
}

/**
 * The one ordering the studio counts scenes in.
 *
 * Content beats come first in playback order, then the overlay and transition
 * layers. The storyboard and the timeline both read from here, so a card
 * numbered 3 and the lane numbered 3 are always the same scene — numbering them
 * independently let the two panes disagree.
 */
export function splitScenes(scenes: Scene[]): {
  content: OrderedScene[];
  layers: OrderedScene[];
} {
  // Playback order, then authored layer order — several scenes legitimately
  // start at 0, and track index is the author's own stacking intent.
  const byStart = [...scenes].sort(
    (a, b) => a.start - b.start || a.trackIndex - b.trackIndex,
  );

  const content = byStart.filter((scene) => groupOf(scene) === "scene");
  const layers = byStart.filter((scene) => groupOf(scene) !== "scene");
  const numbered = [...content, ...layers].map((scene, position) => ({
    scene,
    index: position + 1,
  }));

  return {
    content: numbered.slice(0, content.length),
    layers: numbered.slice(content.length),
  };
}

export function orderedScenes(scenes: Scene[]): OrderedScene[] {
  const { content, layers } = splitScenes(scenes);
  return [...content, ...layers];
}
