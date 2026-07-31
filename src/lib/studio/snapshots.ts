import type { FileNode, Scene } from "./types";

/** `hyperframes snapshot` writes frames as `frame-00-at-2.5s.png`. */
const FRAME_PATTERN = /^frame-\d+-at-([\d.]+)s\.png$/;

export interface SnapshotFrame {
  path: string;
  seconds: number;
}

/**
 * Frames already present in the project. No backend involved: the composer page
 * already ships the project's file tree, and the files route already serves
 * anything inside the project.
 */
export function collectFrames(tree: FileNode[]): SnapshotFrame[] {
  const frames: SnapshotFrame[] = [];

  const walk = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.kind === "folder") {
        walk(node.children ?? []);
        continue;
      }
      const match = FRAME_PATTERN.exec(node.name);
      if (match) frames.push({ path: node.path, seconds: Number(match[1]) });
    }
  };

  walk(tree);
  return frames.sort((a, b) => a.seconds - b.seconds);
}

/** The most representative captured frame for a scene, if one exists. */
export function frameForScene(
  frames: SnapshotFrame[],
  scene: Scene,
): SnapshotFrame | null {
  if (frames.length === 0) return null;

  const end = scene.start + scene.duration;
  const inside = frames.filter(
    (frame) => frame.seconds >= scene.start && frame.seconds < end,
  );

  // Nearest to the middle of the scene, not the first frame in range: several
  // scenes start at 0, and picking the 0s frame for all of them makes the
  // storyboard look like one repeated poster.
  if (inside.length > 0) {
    const middle = scene.start + scene.duration / 2;
    return inside.reduce((best, frame) =>
      Math.abs(frame.seconds - middle) < Math.abs(best.seconds - middle)
        ? frame
        : best,
    );
  }

  const before = frames.filter((frame) => frame.seconds <= scene.start).pop();
  return before ?? null;
}

export function frameUrl(projectSlug: string, frame: SnapshotFrame): string {
  return `/api/hf/${projectSlug}/files/${frame.path}`;
}

export type SceneGroup = "scene" | "transition" | "overlay";

/**
 * Which shelf a composition host belongs on.
 *
 * Registry provenance is the reliable signal — an installed block carries its
 * tags and category. The example's own hand-authored overlay layers have no
 * registry record, so an id containing "overlay" is used as a fallback; it is a
 * naming convention, not a contract, and it only affects grouping.
 */
export function groupOf(scene: Scene): SceneGroup {
  if (scene.isTransition) return "transition";
  if (scene.block?.tags.includes("overlay")) return "overlay";
  if (/overlay/i.test(scene.id)) return "overlay";
  return "scene";
}
