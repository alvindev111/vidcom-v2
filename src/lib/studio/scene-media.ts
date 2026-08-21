import type { Scene } from "./types";

/**
 * Project files a clip references but cannot find (R11.9).
 *
 * A clip whose asset was deleted outside the app must say so with the path, not
 * render as an empty rectangle: the path is the only thing that tells the person
 * which file to put back.
 */
export function missingMediaPaths(scene: Pick<Scene, "media">): string[] {
  return [...new Set(scene.media.filter((item) => item.missing).map((item) => item.src))];
}
