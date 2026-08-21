import type { RelPath } from "@vidcom/contracts";
import postcss, { type ChildNode } from "postcss";

export interface RemoteAssetViolation {
  url: string;
  source: "element-attribute" | "css-url" | "observed-request";
  reference: string;
}

/** Finds remotely declared media in HTML attributes and authored CSS. */
export function scanRemoteMedia(
  documents: readonly { path: RelPath; html: string }[],
  stylesheets: readonly { path: RelPath; css: string }[],
): RemoteAssetViolation[] {
  const violations: RemoteAssetViolation[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    const elements = /<(img|video|audio|source)\b[^>]*>/giu;
    for (const match of document.html.matchAll(elements)) {
      for (const attribute of match[0].matchAll(/\b(?:src|poster)\s*=\s*["']([^"']+)["']/giu)) {
        addRemote(violations, seen, attribute[1]!, "element-attribute", `${document.path}:${lineAt(document.html, match.index)}`);
      }
    }
    for (const attribute of document.html.matchAll(/\bstyle\s*=\s*["']([^"']+)["']/giu)) {
      scanCss(attribute[1]!, `${document.path}:${lineAt(document.html, attribute.index)}`, violations, seen);
    }
    for (const style of document.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
      scanCss(style[1]!, `${document.path}:${lineAt(document.html, style.index)}`, violations, seen);
    }
  }
  for (const stylesheet of stylesheets) scanCss(stylesheet.css, stylesheet.path, violations, seen);
  return violations;
}

/** Lists remote scripts, stylesheets and explicitly declared fonts without blocking them. */
export function scanExternalDependencies(
  documents: readonly { path: RelPath; html: string }[],
  stylesheets: readonly { path: RelPath; css: string }[] = [],
): string[] {
  const dependencies = new Set<string>();
  for (const { html } of documents) {
    for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
      if (isRemote(match[1]!)) dependencies.add(match[1]!);
    }
    for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
      const rel = match[0].match(/\brel\s*=\s*["']([^"']+)["']/iu)?.[1]?.toLowerCase() ?? "";
      const as = match[0].match(/\bas\s*=\s*["']([^"']+)["']/iu)?.[1]?.toLowerCase() ?? "";
      const href = match[0].match(/\bhref\s*=\s*["']([^"']+)["']/iu)?.[1];
      if (href && isRemote(href) && (rel.includes("stylesheet") || as === "font" || rel.includes("preload"))) {
        dependencies.add(href);
      }
    }
  }
  for (const document of documents) {
    for (const style of document.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
      addCssDependencies(style[1]!, dependencies);
    }
  }
  for (const stylesheet of stylesheets) addCssDependencies(stylesheet.css, dependencies);
  return [...dependencies].sort();
}

function scanCss(
  css: string,
  reference: string,
  violations: RemoteAssetViolation[],
  seen: Set<string>,
): void {
  for (const url of scanCssReferences(css).media) {
    addRemote(violations, seen, url, "css-url", reference);
  }
}

function addCssDependencies(css: string, dependencies: Set<string>): void {
  for (const url of scanCssReferences(css).dependencies) {
    if (isRemote(url)) dependencies.add(url);
  }
}

interface CssReferences {
  media: string[];
  dependencies: string[];
}

function scanCssReferences(css: string): CssReferences {
  const media: string[] = [];
  const dependencies: string[] = [];
  const fontFaceDeclarations = new WeakSet<ChildNode>();
  const root = postcss.parse(css, { from: undefined });
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (name === "font-face") {
      rule.walkDecls((declaration) => {
        fontFaceDeclarations.add(declaration);
        dependencies.push(...readCssUrls(declaration.value));
      });
      return;
    }
    if (name === "import") {
      const urls = readCssUrls(rule.params);
      dependencies.push(...(urls.length > 0 ? urls : readLeadingCssString(rule.params)));
      return;
    }
    media.push(...readCssUrls(rule.params));
  });
  root.walkDecls((declaration) => {
    if (!fontFaceDeclarations.has(declaration)) media.push(...readCssUrls(declaration.value));
  });
  return { media, dependencies };
}

function readCssUrls(value: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      index = end < 0 ? value.length : end + 2;
      continue;
    }
    if (value[index] === '"' || value[index] === "'") {
      index = skipCssString(value, index);
      continue;
    }
    const identifier = readCssIdentifier(value, index);
    if (identifier.value !== "url") {
      index = Math.max(index + 1, identifier.next);
      continue;
    }
    index = identifier.next;
    while (index < value.length && cssWhitespace(value[index]!)) index += 1;
    if (value[index] !== "(") continue;
    index += 1;
    while (index < value.length && cssWhitespace(value[index]!)) index += 1;
    const quote = value[index] === '"' || value[index] === "'" ? value[index++]! : null;
    const start = index;
    if (quote) {
      index = skipCssString(value, index - 1) - 1;
      if (index >= value.length || value[index] !== quote) break;
      const url = value.slice(start, index).trim();
      index += 1;
      while (index < value.length && cssWhitespace(value[index]!)) index += 1;
      if (value[index] === ")" && url) urls.push(url);
      index += 1;
      continue;
    }
    while (index < value.length && value[index] !== ")") index += 1;
    if (index >= value.length) break;
    const url = value.slice(start, index).trim();
    if (url) urls.push(url);
    index += 1;
  }
  return urls;
}

function readCssIdentifier(value: string, start: number): { value: string; next: number } {
  let index = start;
  while (index < value.length && cssIdentifierCharacter(value[index]!)) index += 1;
  return { value: value.slice(start, index).toLowerCase(), next: index };
}

function cssIdentifierCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122
    || code >= 48 && code <= 57 || character === "_" || character === "-";
}

function cssWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n" || character === "\f";
}

function skipCssString(css: string, start: number): number {
  const quote = css[start]!;
  let index = start + 1;
  while (index < css.length) {
    if (css[index] === "\\") index += 2;
    else if (css[index++] === quote) break;
  }
  return Math.min(index, css.length);
}

function readLeadingCssString(value: string): string[] {
  let index = 0;
  while (index < value.length) {
    if (value[index] === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      index = end < 0 ? value.length : end + 2;
      continue;
    }
    if (cssWhitespace(value[index]!)) { index += 1; continue; }
    const quote = value[index];
    if (quote !== '"' && quote !== "'") return [];
    const end = skipCssString(value, index) - 1;
    return end < value.length && value[end] === quote ? [value.slice(index + 1, end)] : [];
  }
  return [];
}

function addRemote(
  violations: RemoteAssetViolation[],
  seen: Set<string>,
  url: string,
  source: RemoteAssetViolation["source"],
  reference: string,
): void {
  if (!isRemote(url)) return;
  const key = `${source}\0${url}\0${reference}`;
  if (seen.has(key)) return;
  seen.add(key);
  violations.push({ url, source, reference });
}

function isRemote(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("//");
}

function lineAt(value: string, index = 0): number {
  return value.slice(0, index).split("\n").length;
}
