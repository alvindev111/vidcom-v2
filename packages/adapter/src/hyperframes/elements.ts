import { readClipTiming } from "@hyperframes/core";
import { parseGsapScript } from "@hyperframes/parsers/gsap-parser";
import postcss from "postcss";

import { elementDomPath, inlineScripts } from "./dom";
import type { SceneEffect, SceneElement } from "./types";

const MEDIA_KIND: Record<string, SceneElement["kind"]> = { IMG: "image", VIDEO: "video", AUDIO: "audio" };
const TIMED_SELECTOR = "[data-hf-id],[data-start],[data-duration],[data-end],.clip,img,video,audio";
type Row = Omit<SceneElement, "effects"> & { effects: SceneEffect[] };

function inlineDeclarations(node: Element): Map<string, string> | null {
  const style = node.getAttribute("style");
  if (!style) return new Map();
  try {
    const root = postcss.parse(`x{${style}}`, { from: undefined });
    const rule = root.first;
    if (!rule || rule.type !== "rule") return null;
    const declarations = new Map<string, string>();
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop.toLowerCase(), declaration.value.trim());
    });
    return declarations;
  } catch {
    return null;
  }
}

function pixelOffset(value: string | undefined): number | null {
  if (!value || !/^-?(?:\d+(?:\.\d+)?|\.\d+)px$/u.test(value)) return null;
  const parsed = Number(value.slice(0, -2));
  return Number.isFinite(parsed) ? parsed : null;
}

function authoredLayout(node: Element): Pick<SceneElement, "authoredId" | "layoutOffset" | "positionEditable"> {
  const candidate = node.getAttribute("data-hf-id");
  const authoredId = candidate && candidate.length <= 255 ? candidate : null;
  const declarations = inlineDeclarations(node);
  const ownsOffset = node.hasAttribute("data-vidcom-layout-offset");
  const x = pixelOffset(declarations?.get("--vidcom-layout-x"));
  const y = pixelOffset(declarations?.get("--vidcom-layout-y"));
  const layoutOffset = ownsOffset && x !== null && y !== null ? { x, y } : null;
  const authoredTranslate = !ownsOffset && declarations?.has("translate") === true;
  return {
    authoredId,
    layoutOffset,
    positionEditable: authoredId !== null && declarations !== null && !authoredTranslate
      && (!ownsOffset || layoutOffset !== null),
  };
}

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
  externalScriptRoot?: ParentNode,
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
      ...authoredLayout(node),
      label: id ?? tag.toLowerCase(),
      kind: MEDIA_KIND[tag] ?? "element",
      start: hasOwnTiming ? timing.start ?? 0 : null,
      duration: hasOwnTiming ? timing.duration ?? timing.end ?? null : null,
      src: node.getAttribute("src"),
      effects: [],
    });
  }

  let unresolvedEffects = 0;
  const scriptRoot = externalScriptRoot ?? root;
  const readsExternalScripts = scriptRoot !== root;
  for (const [index, { element, source }] of inlineScripts(scriptRoot).entries()) {
    if (!readsExternalScripts && !owns(element)) continue;
    let animations;
    try {
      animations = parseGsapScript(source).animations;
    } catch {
      continue;
    }
    for (const animation of animations) {
      if (animation.hasUnresolvedSelector || animation.resolvedStart === undefined) {
        // A dynamic selector in a root script has no provable single owner. It
        // remains unresolved on the root track and cannot become evidence for
        // every inline scene.
        if (!readsExternalScripts) unresolvedEffects += 1;
        continue;
      }
      const key = normalizeTarget(animation.targetSelector, compositionId);
      let target: Element | null = null;
      try { target = root.querySelector(key); }
      catch { /* The GSAP parser already marks unsupported dynamic selectors. */ }
      if (readsExternalScripts && target === null) continue;
      if (!readsExternalScripts && target !== null && !owns(target)) continue;
      const row = rows.get(key) ?? {
        id: key,
        authoredId: null,
        label: key,
        kind: "element" as const,
        start: null,
        duration: null,
        src: null,
        layoutOffset: null,
        positionEditable: false,
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
      .filter((row) => row.authoredId !== null || row.effects.length > 0 || row.start !== null)
      .map((row) => ({ ...row, effects: [...row.effects].sort((a, b) => a.start - b.start) }))
      .sort((a, b) => firstMoment(a) - firstMoment(b)),
    unresolvedEffects,
  };
}
