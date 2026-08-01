import { readClipTiming } from "@hyperframes/core";
import { parseGsapScript } from "@hyperframes/parsers/gsap-parser";

import { elementDomPath, inlineScripts } from "./dom";
import type { SceneEffect, SceneElement } from "./types";

const MEDIA_KIND: Record<string, SceneElement["kind"]> = { IMG: "image", VIDEO: "video", AUDIO: "audio" };
const TIMED_SELECTOR = "[data-start],[data-duration],[data-end],.clip,img,video,audio";
type Row = Omit<SceneElement, "effects"> & { effects: SceneEffect[] };

function normalizeTarget(selector: string, compositionId: string): string {
  const scoped = selector
    .replace(`[data-composition-id="${compositionId}"]`, "")
    .replace(`#${compositionId}`, "")
    .trim();
  return scoped || selector;
}

function firstMoment(row: Row): number {
  const effect = row.effects.reduce<number | null>(
    (earliest, item) => earliest === null ? item.start : Math.min(earliest, item.start),
    null,
  );
  return row.start === null ? effect ?? 0 : effect === null ? row.start : Math.min(row.start, effect);
}

/** Parses authored clip timing and statically resolvable GSAP effects without guessing. */
export function readSceneElements(
  root: ParentNode,
  compositionId: string,
  owns: (node: Element) => boolean = () => true,
): { elements: SceneElement[]; unresolvedEffects: number } {
  const rows = new Map<string, Row>();
  for (const node of root.querySelectorAll(TIMED_SELECTOR)) {
    if (node.hasAttribute("data-composition-id") || !owns(node)) continue;
    const tag = node.tagName.toUpperCase();
    const id = node.getAttribute("id");
    const key = id ? `#${id}` : elementDomPath(node, root);
    const timing = readClipTiming(node);
    const hasOwnTiming = ["data-start", "data-duration", "data-end"].some((name) => node.hasAttribute(name));
    rows.set(key, {
      id: key,
      label: id ?? tag.toLowerCase(),
      kind: MEDIA_KIND[tag] ?? "element",
      start: hasOwnTiming ? timing.start ?? 0 : null,
      duration: hasOwnTiming ? timing.duration ?? timing.end ?? null : null,
      src: node.getAttribute("src"),
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
      continue;
    }
    for (const animation of animations) {
      if (animation.hasUnresolvedSelector || animation.resolvedStart === undefined) {
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
        id: `${index}:${animation.id}`,
        method: animation.method,
        start: animation.resolvedStart,
        duration: animation.duration ?? 0,
        ease: animation.ease ?? null,
        propertyGroup: animation.propertyGroup ?? null,
      });
    }
  }

  return {
    elements: [...rows.values()]
      .filter((row) => row.effects.length > 0 || row.start !== null)
      .map((row) => ({ ...row, effects: [...row.effects].sort((a, b) => a.start - b.start) }))
      .sort((a, b) => firstMoment(a) - firstMoment(b)),
    unresolvedEffects,
  };
}
