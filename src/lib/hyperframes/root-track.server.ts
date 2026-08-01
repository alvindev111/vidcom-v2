import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readClipTiming } from "@hyperframes/core";
import { parseHTML } from "linkedom";

import type { RootTrack } from "@/lib/studio/types";
import { memoPerProject, projectPaths } from "./projects.server";
import { readSceneElements } from "./scene-elements.server";

/**
 * The nearest composition host above `node`, or null when there is none.
 *
 * Ownership is decided by this rather than by depth: an element sitting inside
 * `#grain-overlay-comp` belongs to that scene, while one sitting directly in the
 * root host — or outside it entirely, which is where an A-roll `<video>` goes to
 * avoid being nested in a timed element — belongs to the document's own track.
 */
function nearestHost(node: Element): Element | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.hasAttribute("data-composition-id")) return parent;
  }
  return null;
}

/**
 * Root-level media and motion of the entry document.
 *
 * `readScenes` only sees nested composition hosts, so a footage-led composition
 * — one `<video class="clip">` with graphics layered over it — put nothing on the
 * timeline for the footage itself, and nothing for the camera moves authored
 * against it in `index.html`.
 */
export const readRootTrack = memoPerProject(function readRootTrack(
  slug: string,
): RootTrack | null {
  const paths = projectPaths(slug);
  if (!paths) return null;

  const file = join(paths.dir, paths.entry);
  if (!existsSync(file)) return null;

  const { document } = parseHTML(readFileSync(file, "utf8"));
  const hosts = [...document.querySelectorAll("[data-composition-id]")];
  const root =
    hosts.find(
      (host) =>
        host.hasAttribute("data-width") && host.hasAttribute("data-height"),
    ) ?? hosts[0];
  if (!root) return null;

  const timing = readClipTiming(root);
  // Scoped to the whole body, not to the root host: media authored as a sibling
  // of the root still plays as part of this composition.
  const { elements, unresolvedEffects } = readSceneElements(
    document.body,
    root.getAttribute("data-composition-id") ?? "root",
    (node) => {
      const owner = nearestHost(node);
      return owner === null || owner === root;
    },
  );

  if (elements.length === 0 && unresolvedEffects === 0) return null;

  return {
    id: root.getAttribute("data-composition-id") ?? "root",
    duration: timing.duration ?? timing.end ?? 0,
    elements,
    unresolvedEffects,
  };
});
