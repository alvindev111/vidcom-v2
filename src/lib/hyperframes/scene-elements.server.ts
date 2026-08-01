import "server-only";

import { readClipTiming } from "@hyperframes/core";
import { parseGsapScript } from "@hyperframes/parsers/gsap-parser";

import type { SceneEffect, SceneElement } from "@/lib/studio/types";
import { inlineScripts } from "./composition-root.server";

const MEDIA_KIND: Record<string, SceneElement["kind"]> = {
  IMG: "image",
  VIDEO: "video",
  AUDIO: "audio",
};

/** Elements the author gave their own clip timing, plus every media element. */
const TIMED_SELECTOR = "[data-start],[data-duration],[data-end],.clip,img,video,audio";

interface Row {
  id: string;
  label: string;
  kind: SceneElement["kind"];
  start: number | null;
  duration: number | null;
  src: string | null;
  effects: SceneEffect[];
}

/**
 * What is inside a scene, read from its source.
 *
 * Two passes that answer different halves of the question: the DOM gives
 * elements that hold their own slot on the timeline, and the GSAP script gives
 * the motion applied to them. A tween whose target the parser could not resolve
 * — the `groups.forEach(... createElement ...)` shape — is counted rather than
 * guessed at, because a made-up start time on a timeline is worse than a gap.
 */
export function readSceneElements(
  root: ParentNode,
  compositionId: string,
  /**
   * Whether a node belongs to this composition. Only needed when `root` spans
   * more than one composition — reading the entry document's own track, where
   * anything sitting inside a nested host is that scene's business.
   */
  owns: (node: Element) => boolean = () => true,
): { elements: SceneElement[]; unresolvedEffects: number } {
  const rows = new Map<string, Row>();

  for (const node of root.querySelectorAll(TIMED_SELECTOR)) {
    // Composition hosts are scenes in their own right — they get their own lane.
    if (node.hasAttribute("data-composition-id")) continue;
    if (!owns(node)) continue;

    const tag = node.tagName.toUpperCase();
    const kind = MEDIA_KIND[tag] ?? "element";
    const id = node.getAttribute("id");
    const key = id ? `#${id}` : `${tag.toLowerCase()}:${rows.size}`;
    const timing = readClipTiming(node);
    const src = node.getAttribute("src");

    // Timing is only recorded when the author actually wrote it. A media element
    // with neither timing nor a tween carries no time information at all and is
    // dropped below — it belongs in the scene's media list, not on a time axis.
    const hasOwnTiming =
      node.hasAttribute("data-start") ||
      node.hasAttribute("data-duration") ||
      node.hasAttribute("data-end");

    rows.set(key, {
      id: key,
      label: id ?? tag.toLowerCase(),
      kind,
      start: hasOwnTiming ? (timing.start ?? 0) : null,
      duration: hasOwnTiming ? (timing.duration ?? timing.end ?? null) : null,
      src,
      effects: [],
    });
  }

  let unresolvedEffects = 0;

  for (const [index, { element, source }] of inlineScripts(root).entries()) {
    if (!owns(element)) continue;

    let animations;
    try {
      animations = parseGsapScript(source).animations;
    } catch {
      // A script the parser chokes on must not take the whole scene down.
      continue;
    }

    for (const animation of animations) {
      if (
        animation.hasUnresolvedSelector ||
        animation.resolvedStart === undefined
      ) {
        unresolvedEffects += 1;
        continue;
      }

      const key = normalizeTarget(animation.targetSelector, compositionId);
      const row = rows.get(key) ?? {
        id: key,
        label: key,
        kind: "element" as const,
        start: null,
        duration: null,
        src: null,
        effects: [],
      };
      rows.set(key, row);

      row.effects.push({
        // The parser numbers tweens per script (`#stat1-to-4250`), so a scene
        // with two timelines can hand back the same id twice — a duplicate React
        // key on the timeline. Scoping by script index keeps them distinct.
        id: `${index}:${animation.id}`,
        method: animation.method,
        start: animation.resolvedStart,
        duration: animation.duration ?? 0,
        ease: animation.ease ?? null,
        propertyGroup: animation.propertyGroup ?? null,
      });
    }
  }

  const elements = [...rows.values()]
    .filter((row) => row.effects.length > 0 || row.start !== null)
    .map((row) => ({
      ...row,
      effects: [...row.effects].sort((a, b) => a.start - b.start),
    }))
    .sort((a, b) => firstMoment(a) - firstMoment(b));

  return { elements, unresolvedEffects };
}

/** Earliest moment a row is involved in, for ordering the expanded lane. */
function firstMoment(row: Row): number {
  const effect = row.effects.reduce<number | null>(
    (earliest, item) =>
      earliest === null ? item.start : Math.min(earliest, item.start),
    null,
  );
  if (row.start === null) return effect ?? 0;
  return effect === null ? row.start : Math.min(row.start, effect);
}

/**
 * Match a tween's selector to the element row it belongs to.
 *
 * Scaffolded sub-compositions scope their selectors by composition id
 * (`[data-composition-id="intro"] .title-card`), so the prefix is stripped
 * before matching; a bare `#stat1` then lands on the `#stat1` row instead of
 * opening a second row for the same element.
 */
function normalizeTarget(selector: string, compositionId: string): string {
  const scoped = selector
    .replace(`[data-composition-id="${compositionId}"]`, "")
    .replace(`#${compositionId}`, "")
    .trim();
  return scoped || selector;
}
