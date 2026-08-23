import path from "node:path";

import type { RelPath } from "@vidcom/contracts";

export interface CssChunk {
  path: RelPath;
  css: string;
  projectRootRelative?: boolean;
}

export interface FontFace {
  family: string;
  paths: RelPath[];
  hasUninspectableSource: boolean;
}

interface FontRule {
  selectors: string[];
  family: string;
  specificity: readonly [number, number, number];
  order: number;
}

export interface TextRun {
  text: string;
  family: string | null;
}

export function cssResourcePath(owner: RelPath, raw: string, projectRootRelative = false): RelPath | null {
  const clean = raw.trim().split(/[?#]/u, 1)[0]?.split("\\").join("/") ?? "";
  if (!clean || clean.startsWith("/") || clean.startsWith("//")
    || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(clean)) return null;
  const base = projectRootRelative && !clean.startsWith("../") ? "" : path.posix.dirname(owner);
  const resolved = path.posix.normalize(path.posix.join(base, clean)).replace(/^\.\//u, "");
  return resolved === ".." || resolved.startsWith("../") ? null : resolved as RelPath;
}

function declaration(block: string, property: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;!}]+)`, "iu").exec(block);
  return match?.[1]?.trim() || null;
}

function normalizeFamily(value: string): string {
  return value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2").trim();
}

export function fontFamilies(value: string): string[] {
  if (/\bvar\s*\(/iu.test(value)) return [];
  return value.split(",").map(normalizeFamily).filter(Boolean);
}

export function parseFontFaces(chunks: readonly CssChunk[]): Map<string, FontFace> {
  const faces = new Map<string, FontFace>();
  for (const chunk of chunks) {
    for (const match of chunk.css.matchAll(/@font-face\s*\{([\s\S]*?)\}/giu)) {
      const family = declaration(match[1]!, "font-family");
      const source = declaration(match[1]!, "src");
      if (!family || !source) continue;
      const name = normalizeFamily(family);
      const paths: RelPath[] = [];
      let hasUninspectableSource = /\blocal\s*\(/iu.test(source);
      for (const url of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/giu)) {
        const resolved = cssResourcePath(chunk.path, url[1]!, chunk.projectRootRelative === true);
        if (resolved) paths.push(resolved);
        else hasUninspectableSource = true;
      }
      const key = name.toLocaleLowerCase("en-US");
      const previous = faces.get(key);
      faces.set(key, {
        family: name,
        paths: [...new Set([...(previous?.paths ?? []), ...paths])],
        hasUninspectableSource: hasUninspectableSource || previous?.hasUninspectableSource === true,
      });
    }
  }
  return faces;
}

function selectorSpecificity(selector: string): readonly [number, number, number] {
  const ids = selector.match(/#[\w-]+/gu)?.length ?? 0;
  const classes = selector.match(/(?:\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+)/gu)?.length ?? 0;
  const tags = selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+/gu, " ")
    .match(/(?:^|[\s>+~])(?:[a-z][\w-]*|\*)/giu)?.filter((value) => !value.trim().endsWith("*")).length ?? 0;
  return [ids, classes, tags];
}

function compareSpecificity(left: FontRule, right: FontRule): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.specificity[index]! - right.specificity[index]!;
    if (difference !== 0) return difference;
  }
  return left.order - right.order;
}

function parseFontRules(chunks: readonly CssChunk[]): FontRule[] {
  const rules: FontRule[] = [];
  let order = 0;
  for (const chunk of chunks) {
    const css = chunk.css.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/@font-face\s*\{[\s\S]*?\}/giu, " ");
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const family = declaration(match[2]!, "font-family");
      if (!family || match[1]!.trim().startsWith("@")) continue;
      for (const selector of match[1]!.split(",").map((value) => value.trim()).filter(Boolean)) {
        rules.push({ selectors: [selector], family, specificity: selectorSpecificity(selector), order });
        order += 1;
      }
    }
  }
  return rules;
}

function familyForElement(element: Element, rules: readonly FontRule[]): string | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const inline = declaration(current.getAttribute("style") ?? "", "font-family");
    if (inline) return inline;
    const matching = rules.filter((rule) => {
      try { return rule.selectors.some((selector) => current.matches(selector)); } catch { return false; }
    }).sort(compareSpecificity);
    const selected = matching.at(-1);
    if (selected) return selected.family;
  }
  return null;
}

export function relevantCodePoints(text: string): number[] {
  return [...new Set([...text].flatMap((character) => {
    const value = character.codePointAt(0)!;
    return value > 0x7f && !/\p{White_Space}/u.test(character) ? [value] : [];
  }))].sort((left, right) => left - right);
}

export function collectTextRuns(root: ParentNode, chunks: readonly CssChunk[]): TextRun[] {
  const rules = parseFontRules(chunks);
  const runs: TextRun[] = [];
  const visit = (node: Node, parent: Element | null): void => {
    if (node.nodeType === 3 && parent) {
      const text = node.textContent?.replace(/\s+/gu, " ").trim() ?? "";
      if (relevantCodePoints(text).length > 0) runs.push({ text, family: familyForElement(parent, rules) });
      return;
    }
    if (node.nodeType !== 1 && node !== root) return;
    const element = node.nodeType === 1 ? node as Element : parent;
    if (element && ["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName.toUpperCase())) return;
    for (const child of [...node.childNodes]) visit(child, element);
  };
  visit(root as Node, null);
  return runs;
}
