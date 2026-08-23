import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveWithinProject } from "@hyperframes/core";
import { parse, type Node } from "acorn";
import { simple } from "acorn-walk";
import { parseHTML } from "linkedom";
import postcss from "postcss";

import { ErrorCode, type ContentHash, type DomainError, type RelPath } from "@vidcom/contracts";
import {
  err,
  ok,
  type CompositionDependency,
  type CompositionDependencyPort,
  type ProjectPathInvalidator,
  type ProjectRef,
  type Result,
} from "@vidcom/core";

import { authoredCompositionRoot } from "./dom";
import { readCssValueReferences } from "./safe-css";

type DependencyKind = "html" | "css" | "javascript" | "asset";
type PendingDependency = { path: RelPath; kind: DependencyKind };

class GraphUnavailable extends Error {}

function unavailable(message: string): never {
  throw new GraphUnavailable(message);
}

function canonicalReference(owner: RelPath, raw: string, projectRootRelative = false): RelPath | null {
  const value = raw.trim().split(/[?#]/u, 1)[0]?.split("\\").join("/") ?? "";
  if (!value || value.startsWith("/") || value.startsWith("//") || value.startsWith("#")
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  const base = projectRootRelative && !value.startsWith("../") ? "" : path.posix.dirname(owner);
  const resolved = path.posix.normalize(path.posix.join(base, value)).replace(/^\.\//u, "");
  return resolved === ".." || resolved.startsWith("../") ? null : resolved as RelPath;
}

function kindFor(reference: RelPath, fallback: DependencyKind): DependencyKind {
  switch (path.posix.extname(reference).toLowerCase()) {
    case ".html":
    case ".htm": return "html";
    case ".css": return "css";
    case ".js":
    case ".mjs":
    case ".cjs": return "javascript";
    default: return fallback;
  }
}

function hash(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

function quotedImport(value: string): string | null {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return null;
  let index = 1;
  while (index < value.length) {
    if (value[index] === "\\") return unavailable("escaped CSS imports are not statically resolved");
    if (value[index] === quote) return value.slice(1, index);
    index += 1;
  }
  return unavailable("CSS import string is not closed");
}

function cssPropertyMayReferenceResource(property: string): boolean {
  const name = property.toLowerCase();
  return name === "content" || name === "cursor" || name === "filter" || name === "src"
    || name === "background" || name.startsWith("background-")
    || name === "border-image" || name.startsWith("border-image-")
    || name === "list-style" || name.startsWith("list-style-")
    || name === "mask" || name.startsWith("mask-");
}

function cssReferences(css: string, owner: RelPath, projectRootRelative = false): PendingDependency[] {
  let root;
  try { root = postcss.parse(css, { from: undefined }); }
  catch { return unavailable(`CSS dependency parsing failed for ${owner}`); }
  const found: PendingDependency[] = [];
  const add = (raw: string, fallback: DependencyKind) => {
    const reference = canonicalReference(owner, raw, projectRootRelative);
    if (reference) found.push({ path: reference, kind: kindFor(reference, fallback) });
  };
  root.walkAtRules((rule) => {
    const scanned = readCssValueReferences(rule.params);
    if (!scanned || scanned.hasDynamicReference) unavailable(`CSS dependency is dynamic in ${owner}`);
    if (rule.name.toLowerCase() === "import") {
      const direct = quotedImport(rule.params.trim());
      if (direct) add(direct, "css");
      else if (scanned.urls.length === 0) unavailable(`CSS import is not statically resolved in ${owner}`);
    }
    for (const url of scanned.urls) add(url, rule.name.toLowerCase() === "import" ? "css" : "asset");
  });
  root.walkDecls((declaration) => {
    const scanned = readCssValueReferences(declaration.value);
    if (!scanned || (scanned.hasDynamicReference && cssPropertyMayReferenceResource(declaration.prop))
      || (declaration.prop.startsWith("--") && scanned.urls.length > 0)) {
      unavailable(`CSS dependency is dynamic in ${owner}`);
    }
    for (const url of scanned.urls) add(url, "asset");
  });
  return found;
}

function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof (node as Node & { value?: unknown }).value === "string") {
    return (node as Node & { value: string }).value;
  }
  if (node.type === "TemplateLiteral") {
    const template = node as Node & { expressions: Node[]; quasis: Array<{ value: { cooked?: string | null } }> };
    return template.expressions.length === 0 ? template.quasis[0]?.value.cooked ?? null : null;
  }
  return null;
}

function importMetaUrl(node: Node | null | undefined): boolean {
  if (!node || node.type !== "MemberExpression") return false;
  const member = node as Node & { object: Node; property: Node; computed: boolean };
  if (member.computed || member.property.type !== "Identifier"
    || (member.property as Node & { name: string }).name !== "url"
    || member.object.type !== "MetaProperty") return false;
  const meta = member.object as Node & { meta: Node; property: Node };
  return meta.meta.type === "Identifier" && (meta.meta as Node & { name: string }).name === "import"
    && meta.property.type === "Identifier" && (meta.property as Node & { name: string }).name === "meta";
}

function memberName(node: Node): string | null {
  if (node.type !== "MemberExpression") return null;
  const member = node as Node & { property: Node; computed: boolean };
  if (!member.computed && member.property.type === "Identifier") {
    return (member.property as Node & { name: string }).name;
  }
  return member.computed ? stringValue(member.property) : null;
}

function javascriptReferences(source: string, owner: RelPath, projectRootRelative = false): PendingDependency[] {
  let syntax;
  try { syntax = parse(source, { ecmaVersion: "latest", sourceType: "module" }); }
  catch { return unavailable(`JavaScript dependency parsing failed for ${owner}`); }
  const rawReferences: Array<{ value: string; bareImport: boolean }> = [];
  const addImport = (node: Node | null | undefined) => {
    const value = stringValue(node);
    if (value === null) unavailable(`JavaScript import is dynamic in ${owner}`);
    rawReferences.push({ value, bareImport: true });
  };
  const addRuntimeUrl = (node: Node | null | undefined) => {
    const value = stringValue(node);
    if (value === null) unavailable(`JavaScript URL is dynamic in ${owner}`);
    rawReferences.push({ value, bareImport: false });
  };
  simple(syntax, {
    ImportDeclaration(node) { addImport(node.source); },
    ExportNamedDeclaration(node) { if (node.source) addImport(node.source); },
    ExportAllDeclaration(node) { addImport(node.source); },
    ImportExpression(node) { addImport(node.source); },
    NewExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "URL"
        && node.arguments.length >= 2 && importMetaUrl(node.arguments[1] as Node)) {
        addRuntimeUrl(node.arguments[0] as Node);
      }
    },
    AssignmentExpression(node) {
      if (["src", "href", "poster", "srcset"].includes(memberName(node.left) ?? "")) {
        addRuntimeUrl(node.right);
      }
    },
    CallExpression(node) {
      if (memberName(node.callee) !== "setAttribute") return;
      const attribute = stringValue(node.arguments[0] as Node);
      if (attribute && ["src", "href", "poster", "srcset"].includes(attribute.toLowerCase())) {
        addRuntimeUrl(node.arguments[1] as Node);
      }
    },
  });
  return rawReferences.flatMap(({ value, bareImport }) => {
    if (bareImport && !value.startsWith("./") && !value.startsWith("../")) return [];
    const reference = canonicalReference(owner, value, projectRootRelative);
    return reference ? [{ path: reference, kind: kindFor(reference, bareImport ? "javascript" : "asset") }] : [];
  });
}

function htmlReferences(html: string, owner: RelPath): PendingDependency[] {
  let document: Document;
  try { ({ document } = parseHTML(html)); }
  catch { return unavailable(`HTML dependency parsing failed for ${owner}`); }
  const root = authoredCompositionRoot(document);
  const found: PendingDependency[] = [];
  const add = (raw: string, fallback: DependencyKind, projectRootRelative = true) => {
    const reference = canonicalReference(owner, raw, projectRootRelative);
    if (reference) found.push({ path: reference, kind: kindFor(reference, fallback) });
  };
  for (const element of [...root.querySelectorAll("[src], [href], [data-composition-src]")]) {
    const compositionSource = element.getAttribute("data-composition-src");
    const source = element.getAttribute("src");
    const href = element.getAttribute("href");
    if (compositionSource) add(compositionSource, "html", false);
    if (source) add(source, element.tagName.toUpperCase() === "SCRIPT" ? "javascript" : "asset");
    if (href) add(href, element.tagName.toUpperCase() === "LINK"
      && element.getAttribute("rel")?.toLowerCase().split(/\s+/u).includes("stylesheet")
      ? "css"
      : "asset");
  }
  for (const style of [...root.querySelectorAll("style")]) {
    found.push(...cssReferences(style.textContent ?? "", owner, true));
  }
  for (const element of [...root.querySelectorAll("[style]")]) {
    found.push(...cssReferences(`x{${element.getAttribute("style") ?? ""}}`, owner, true));
  }
  for (const script of [...root.querySelectorAll("script:not([src])")]) {
    const type = script.getAttribute("type")?.toLowerCase();
    if (type && type !== "module" && type !== "text/javascript" && type !== "application/javascript") continue;
    found.push(...javascriptReferences(script.textContent ?? "", owner, true));
  }
  return found;
}

function sceneSource(ref: ProjectRef, entry: string, sceneId: string): RelPath | null {
  const { document } = parseHTML(entry);
  const host = [...authoredCompositionRoot(document).querySelectorAll("[data-composition-id]")]
    .find((element) => element.getAttribute("data-composition-id") === sceneId);
  if (!host) return null;
  const source = host.getAttribute("data-composition-src");
  return source ? canonicalReference(ref.entry, source) : ref.entry;
}

interface DependencyMemo {
  projectId: ProjectRef["id"];
  ownedPaths: ReadonlySet<RelPath>;
  result: Result<CompositionDependency[], DomainError>;
}

function normalizedRelativePath(value: RelPath): string {
  return path.posix.normalize(value.split("\\").join("/")).replace(/^\.\//u, "").replace(/\/$/u, "");
}

function pathsOverlap(left: RelPath, right: RelPath): boolean {
  const a = normalizedRelativePath(left);
  const b = normalizedRelativePath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export class HyperframesCompositionDependencyGraph implements CompositionDependencyPort, ProjectPathInvalidator {
  private readonly memo = new Map<string, DependencyMemo>();

  invalidate(projectId: ProjectRef["id"], changedPaths: readonly RelPath[]): void {
    for (const [key, entry] of this.memo) {
      if (entry.projectId !== projectId) continue;
      if ([...entry.ownedPaths].some((owned) => changedPaths.some((changed) => pathsOverlap(owned, changed)))) {
        this.memo.delete(key);
      }
    }
  }

  async dependenciesOf(ref: ProjectRef, sceneId: string): Promise<Result<CompositionDependency[], DomainError>> {
    const memoKey = `${ref.id}\u0000${sceneId}`;
    const memoized = this.memo.get(memoKey);
    if (memoized) return memoized.result;
    try {
      const entryFilename = resolveWithinProject(ref.root, ref.entry);
      if (!entryFilename || !existsSync(entryFilename)) {
        return err({ code: ErrorCode.DependencyGraphUnavailable, message: "project entry is unavailable" });
      }
      const entry = readFileSync(entryFilename, "utf8");
      const source = sceneSource(ref, entry, sceneId);
      if (!source) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found" });
      const sourceFilename = resolveWithinProject(ref.root, source);
      if (!sourceFilename || !existsSync(sourceFilename)) {
        return err({ code: ErrorCode.DependencyGraphUnavailable, message: "scene source is unavailable" });
      }

      const dependencies = new Map<RelPath, CompositionDependency>();
      const visited = new Set<RelPath>([source]);
      const pending = htmlReferences(readFileSync(sourceFilename, "utf8"), source);
      while (pending.length > 0) {
        const next = pending.shift()!;
        if (visited.has(next.path)) continue;
        visited.add(next.path);
        const filename = resolveWithinProject(ref.root, next.path);
        if (!filename || !existsSync(filename)) {
          dependencies.set(next.path, { path: next.path, state: "missing", contentHash: null });
          continue;
        }
        const metadata = lstatSync(filename);
        if (metadata.isSymbolicLink() || !metadata.isFile()) unavailable(`dependency is not a regular file: ${next.path}`);
        const bytes = readFileSync(filename);
        dependencies.set(next.path, { path: next.path, state: "present", contentHash: hash(bytes) });
        const kind = kindFor(next.path, next.kind);
        if (kind === "html") pending.push(...htmlReferences(bytes.toString("utf8"), next.path));
        else if (kind === "css") pending.push(...cssReferences(bytes.toString("utf8"), next.path));
        else if (kind === "javascript") pending.push(...javascriptReferences(bytes.toString("utf8"), next.path));
      }
      const result = ok([...dependencies.values()].sort((left, right) => left.path.localeCompare(right.path, "en")));
      this.memo.set(memoKey, {
        projectId: ref.id,
        ownedPaths: new Set<RelPath>([ref.entry, ...visited]),
        result,
      });
      return result;
    } catch (error) {
      return err({
        code: ErrorCode.DependencyGraphUnavailable,
        message: error instanceof Error ? error.message : "dependency graph is unavailable",
      });
    }
  }
}
