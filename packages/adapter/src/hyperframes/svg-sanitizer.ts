import { createHash } from "node:crypto";

import { ErrorCode, type DomainError } from "@vidcom/contracts";
import { err, ok, type Result, type StagedFileSource, type SvgSanitizerPort } from "@vidcom/core";
import { DOMParser } from "linkedom";

import { openRegularFileNoFollow } from "../fs/regular-file";
import { hasOnlyLocalCssUrls, sanitizeInlineStyle, sanitizeStylesheet } from "./safe-css";

const MAX_SVG_BYTES = 25 * 1024 * 1024;
const ACTIVE_ELEMENTS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);
const DIRECT_URL_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);
const CSS_URL_ATTRIBUTES = new Set([
  "fill", "stroke", "filter", "clip-path", "mask", "marker", "marker-start", "marker-mid", "marker-end", "cursor",
]);

function unsupported(message: string): Result<never, DomainError> {
  return err({ code: ErrorCode.UnsupportedMedia, message });
}

function validEntity(source: string, start: number): number {
  const end = source.indexOf(";", start + 1);
  if (end < 0) return -1;
  const name = source.slice(start + 1, end);
  if (["amp", "lt", "gt", "quot", "apos"].includes(name)) return end + 1;
  if (name.startsWith("#") && name.length > 1) return end + 1;
  return -1;
}

/** Strict well-formedness gate before linkedom's intentionally forgiving DOM parser. */
function wellFormedXml(source: string): boolean {
  for (let offset = source.indexOf("&"); offset >= 0; offset = source.indexOf("&", offset)) {
    const next = validEntity(source, offset);
    if (next < 0) return false;
    offset = next;
  }
  const stack: string[] = [];
  let roots = 0;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "<") {
      if (stack.length === 0 && source[index]!.trim() !== "") return false;
      index += 1;
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) return false;
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      if (stack.length === 0) return false;
      const end = source.indexOf("]]>", index + 9);
      if (end < 0) return false;
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end < 0) return false;
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!", index)) return false;
    let end = index + 1;
    let quote: string | null = null;
    while (end < source.length) {
      const character = source[end]!;
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      end += 1;
    }
    if (end >= source.length || quote) return false;
    let token = source.slice(index + 1, end).trim();
    const closing = token.startsWith("/");
    const selfClosing = token.endsWith("/");
    if (closing) token = token.slice(1).trim();
    if (selfClosing) token = token.slice(0, -1).trimEnd();
    const nameEnd = [...token].findIndex((character) => character <= " ");
    const name = nameEnd < 0 ? token : token.slice(0, nameEnd);
    if (!name || name.includes("/") || name.includes("<")) return false;
    if (closing) {
      if (selfClosing || stack.pop() !== name) return false;
    } else {
      if (stack.length === 0) roots += 1;
      if (!selfClosing) stack.push(name);
    }
    index = end + 1;
  }
  return roots === 1 && stack.length === 0;
}

function fragment(value: string): boolean {
  const candidate = value.trim();
  return candidate.startsWith("#") && candidate.length > 1 && ![...candidate].some((character) => character <= " ");
}

function sanitizeDocument(document: Document): boolean {
  const root = document.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg") return false;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (ACTIVE_ELEMENTS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")
        || name === "xml:base"
        || (DIRECT_URL_ATTRIBUTES.has(name) && !fragment(attribute.value))
        || (CSS_URL_ATTRIBUTES.has(name) && !hasOnlyLocalCssUrls(attribute.value))) {
        element.removeAttribute(attribute.name);
      } else if (name === "style") {
        const clean = sanitizeInlineStyle(attribute.value);
        if (clean) element.setAttribute(attribute.name, clean);
        else element.removeAttribute(attribute.name);
      }
    }
  }
  for (const style of [...root.querySelectorAll("style")]) {
    const clean = sanitizeStylesheet(style.textContent ?? "");
    if (clean === null) return false;
    style.textContent = clean;
  }
  return true;
}

export class DomSvgSanitizer implements SvgSanitizerPort {
  async sanitize(source: StagedFileSource): Promise<Result<string, DomainError>> {
    try {
      const handle = await openRegularFileNoFollow(source.sourcePath, "SVG source is not a regular file");
      try {
        const metadata = await handle.stat();
        if (metadata.size > MAX_SVG_BYTES) return unsupported("SVG exceeds the 25 MB image limit");
        const bytes = new Uint8Array(await handle.readFile());
        const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (actual !== source.contentHash) return unsupported("SVG staged source hash changed");
        let raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (raw.startsWith("\uFEFF")) raw = raw.slice(1);
        if (!wellFormedXml(raw)) return unsupported("SVG is not well-formed XML");
        const document = new DOMParser().parseFromString(raw, "image/svg+xml");
        if (!document || !sanitizeDocument(document as unknown as Document)) {
          return unsupported("SVG document is unsupported");
        }
        const serialized = document.documentElement.outerHTML;
        const reparsed = new DOMParser().parseFromString(serialized, "image/svg+xml");
        if (!reparsed?.documentElement || reparsed.documentElement.localName.toLowerCase() !== "svg") {
          return unsupported("sanitized SVG could not be parsed");
        }
        return ok(serialized);
      } finally {
        await handle.close();
      }
    } catch {
      return unsupported("SVG could not be sanitized");
    }
  }
}
