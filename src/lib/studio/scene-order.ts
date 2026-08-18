import { groupOf } from "./snapshots";
import type { Scene } from "./types";

export interface OrderedScene {
  scene: Scene;
  /** Storyboard position, 1-based — the number shown on the card and the lane. */
  index: number;
}

export type SceneReorderIntent =
  | { kind: "ready"; sceneId: string; toIndex: number; toTrackIndex?: number }
  | { kind: "boundary" }
  | { kind: "rejected"; message: string };

function scenesInGroupTrack(
  scenes: readonly Scene[],
  scene: Scene,
  trackIndex = scene.trackIndex,
): Scene[] {
  const group = groupOf(scene);
  return scenes
    .filter((candidate) => candidate.trackIndex === trackIndex && groupOf(candidate) === group)
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
}

/** Maps a visual insertion marker to Core's group-relative index. */
export function reorderDropIntent(
  scenes: readonly Scene[],
  movingId: string,
  targetId: string,
  placement: "before" | "after",
  options: { allowCrossTrack?: boolean } = {},
): SceneReorderIntent {
  const moving = scenes.find((scene) => scene.id === movingId);
  const target = scenes.find((scene) => scene.id === targetId);
  if (!moving || !target) return { kind: "rejected", message: "Scene was not found." };
  if (groupOf(moving) !== groupOf(target)) {
    return { kind: "rejected", message: "Scenes can only be reordered inside the same group." };
  }
  if (moving.trackIndex !== target.trackIndex && !options.allowCrossTrack) {
    return { kind: "rejected", message: "Scenes can only be reordered inside the same track." };
  }

  const candidates = scenesInGroupTrack(scenes, moving, target.trackIndex)
    .filter((scene) => scene.id !== moving.id);
  const targetIndex = candidates.findIndex((scene) => scene.id === target.id);
  if (targetIndex < 0) return { kind: "boundary" };
  const intent: SceneReorderIntent = {
    kind: "ready",
    sceneId: moving.id,
    toIndex: targetIndex + (placement === "after" ? 1 : 0),
  };
  if (moving.trackIndex !== target.trackIndex) intent.toTrackIndex = target.trackIndex;
  return intent;
}

/** Maps Alt+Arrow movement without deriving new scene timing in the UI. */
export function keyboardReorderIntent(
  scenes: readonly Scene[],
  sceneId: string,
  direction: -1 | 1,
): SceneReorderIntent {
  const moving = scenes.find((scene) => scene.id === sceneId);
  if (!moving) return { kind: "rejected", message: "Scene was not found." };
  const candidates = scenesInGroupTrack(scenes, moving);
  const currentIndex = candidates.findIndex((scene) => scene.id === sceneId);
  const toIndex = currentIndex + direction;
  if (currentIndex < 0 || toIndex < 0 || toIndex >= candidates.length) return { kind: "boundary" };
  return { kind: "ready", sceneId, toIndex };
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
