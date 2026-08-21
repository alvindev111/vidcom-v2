import postcss, { type ChildNode, type Declaration } from "postcss";

const UNSAFE_FUNCTIONS = new Set(["image", "image-set", "-webkit-image-set", "cross-fade", "element", "src"]);
const UNSAFE_PROPERTIES = new Set(["behavior", "-moz-binding"]);

function identifierCharacter(character: string, first: boolean): boolean {
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90
    || code >= 97 && code <= 122
    || !first && code >= 48 && code <= 57
    || character === "_"
    || character === "-";
}

function whitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n" || character === "\f";
}

function localFragment(value: string): boolean {
  let candidate = value.trim();
  if ((candidate.startsWith('"') && candidate.endsWith('"'))
    || (candidate.startsWith("'") && candidate.endsWith("'"))) {
    candidate = candidate.slice(1, -1).trim();
  }
  if (!candidate.startsWith("#") || candidate.length === 1) return false;
  for (const character of candidate.slice(1)) {
    if (character <= " " || ['"', "'", "(", ")", "\\"].includes(character)) return false;
  }
  return true;
}

export interface CssValueReferences {
  urls: string[];
  hasDynamicReference: boolean;
}

/** Tokenizes CSS values without mistaking strings or comments for URL-bearing functions. */
export function readCssValueReferences(value: string): CssValueReferences | null {
  const urls: string[] = [];
  let hasDynamicReference = false;
  let index = 0;
  while (index < value.length) {
    if (value[index] === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index++];
      let closed = false;
      while (index < value.length) {
        if (value[index] === "\\") index += 2;
        else if (value[index++] === quote) { closed = true; break; }
      }
      if (!closed) return null;
      continue;
    }
    if (!identifierCharacter(value[index]!, true)) { index += 1; continue; }
    const start = index;
    while (index < value.length && identifierCharacter(value[index]!, false)) index += 1;
    const identifier = value.slice(start, index).toLowerCase();
    while (index < value.length && whitespace(value[index]!)) index += 1;
    if (value[index] !== "(") continue;
    if (identifier === "var") hasDynamicReference = true;
    if (identifier !== "url") { index += 1; continue; }

    const argumentStart = ++index;
    let quote: string | null = null;
    while (index < value.length) {
      const character = value[index]!;
      if (quote) {
        if (character === "\\") index += 2;
        else { index += 1; if (character === quote) quote = null; }
      } else if (character === '"' || character === "'") { quote = character; index += 1; }
      else if (character === ")") break;
      else index += 1;
    }
    if (index >= value.length || quote) return null;
    let reference = value.slice(argumentStart, index).trim();
    if ((reference.startsWith('"') && reference.endsWith('"'))
      || (reference.startsWith("'") && reference.endsWith("'"))) {
      reference = reference.slice(1, -1).trim();
    }
    if (!reference || reference.includes("\\")) return null;
    urls.push(reference);
    index += 1;
  }
  return { urls, hasDynamicReference };
}

/** CSS value scanner that understands strings/comments/functions well enough to inspect every URL token. */
export function hasOnlyLocalCssUrls(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    if (value[index] === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) return false;
      index = end + 2;
      continue;
    }
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index++];
      let closed = false;
      while (index < value.length) {
        if (value[index] === "\\") index += 2;
        else if (value[index++] === quote) { closed = true; break; }
      }
      if (!closed) return false;
      continue;
    }
    if (!identifierCharacter(value[index]!, true)) { index += 1; continue; }
    const start = index;
    while (index < value.length && identifierCharacter(value[index]!, false)) index += 1;
    const identifier = value.slice(start, index).toLowerCase();
    while (index < value.length && whitespace(value[index]!)) index += 1;
    if (value[index] !== "(") continue;
    if (identifier === "expression" || UNSAFE_FUNCTIONS.has(identifier)) return false;
    if (identifier !== "url") { index += 1; continue; }
    const argumentStart = ++index;
    let quote: string | null = null;
    while (index < value.length) {
      const character = value[index]!;
      if (quote) {
        if (character === "\\") index += 2;
        else { index += 1; if (character === quote) quote = null; }
      } else if (character === '"' || character === "'") { quote = character; index += 1; }
      else if (character === ")") break;
      else index += 1;
    }
    if (index >= value.length || quote || !localFragment(value.slice(argumentStart, index))) return false;
    index += 1;
  }
  return true;
}

function cleanNode(node: ChildNode): void {
  if (node.type === "atrule" && ["import", "namespace", "document", "font-face"].includes(node.name.toLowerCase())) {
    node.remove();
    return;
  }
  if (node.type === "decl" && (UNSAFE_PROPERTIES.has(node.prop.toLowerCase()) || !hasOnlyLocalCssUrls(node.value))) {
    node.remove();
  }
  if (node.type === "atrule" && !hasOnlyLocalCssUrls(node.params)) node.remove();
}

export function sanitizeStylesheet(css: string): string | null {
  try {
    const root = postcss.parse(css, { from: undefined });
    root.walk(cleanNode);
    return root.toString();
  } catch {
    return null;
  }
}

export function sanitizeInlineStyle(css: string): string | null {
  try {
    const root = postcss.parse(`x{${css}}`, { from: undefined });
    const rule = root.first;
    if (!rule || rule.type !== "rule") return null;
    rule.walkDecls((declaration: Declaration) => {
      if (UNSAFE_PROPERTIES.has(declaration.prop.toLowerCase()) || !hasOnlyLocalCssUrls(declaration.value)) {
        declaration.remove();
      }
    });
    return rule.nodes.map((node) => node.toString()).join("");
  } catch {
    return null;
  }
}
