import type { RelPath } from "@vidcom/contracts";

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
  const mediaCss = css
    .replace(/@font-face\s*\{[\s\S]*?\}/giu, "")
    .replace(/@import\s+(?:url\([^)]*\)|["'][^"']+["'])[^;]*;/giu, "");
  for (const match of mediaCss.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/giu)) {
    addRemote(violations, seen, match[1]!, "css-url", reference);
  }
}

function addCssDependencies(css: string, dependencies: Set<string>): void {
  for (const declaration of [
    ...css.matchAll(/@font-face\s*\{[\s\S]*?\}/giu),
    ...css.matchAll(/@import\s+(?:url\([^)]*\)|["'][^"']+["'])[^;]*;/giu),
  ]) {
    for (const match of declaration[0].matchAll(
      /url\(\s*["']?([^"')\s]+)["']?\s*\)|["']((?:https?:)?\/\/[^"']+)["']/giu,
    )) {
      const url = match[1] ?? match[2];
      if (url && isRemote(url)) dependencies.add(url);
    }
  }
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
  return /^(?:https?:)?\/\//iu.test(url.trim());
}

function lineAt(value: string, index = 0): number {
  return value.slice(0, index).split("\n").length;
}
