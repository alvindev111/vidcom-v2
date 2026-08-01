import "server-only";

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import {
  getHyperframeRuntimeScript,
  parseNumeric,
  readClipTiming,
  resolveWithinProject,
} from "@hyperframes/core";
import {
  buildSubCompositionHtml,
  getMimeType,
} from "@hyperframes/studio-server";
import { DOMParser, parseHTML } from "linkedom";

import type { FileNode, SourceFile } from "@/lib/studio/types";

// @hyperframes/parsers reads compositions with the DOM's DOMParser, which does
// not exist in Node. The hyperframes CLI installs linkedom's implementation as
// the global for exactly this reason; server-side parsing needs the same shim.
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
}

/** Every project is a real HyperFrames project directory (has hyperframes.json). */
export const PROJECTS_ROOT = join(process.cwd(), "projects");

/** Where the preview HTML loads the hyperframe runtime from. */
export const RUNTIME_URL = "/api/hf/runtime";

export interface HyperframesProject {
  slug: string;
  title: string;
  description?: string;
  width: number;
  height: number;
  /** Root composition duration in seconds, or null when the HTML omits it. */
  duration: number | null;
  entry: string;
}

function projectDir(slug: string): string | null {
  const dir = resolveWithinProject(PROJECTS_ROOT, slug);
  if (!dir || !existsSync(join(dir, "hyperframes.json"))) return null;
  return dir;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function listProjectSlugs(): string[] {
  if (!existsSync(PROJECTS_ROOT)) return [];
  return readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => projectDir(name) !== null)
    .sort();
}

/** Where a project's registry lives, per its hyperframes.json. */
export function projectPaths(
  slug: string,
): { dir: string; entry: string; registryBaseUrl: string | null } | null {
  const dir = projectDir(slug);
  if (!dir) return null;

  const config = readJson(join(dir, "hyperframes.json"));
  return {
    dir,
    entry: "index.html",
    registryBaseUrl:
      typeof config?.registry === "string"
        ? config.registry.replace(/\/$/, "")
        : null,
  };
}

const IGNORED_ENTRIES = new Set(["node_modules", ".git", ".hyperframes"]);

/**
 * Path, size and mtime of every file the studio can see in a project.
 *
 * Projects are read fresh on every request — they are `force-dynamic` because
 * the agent and the CLI edit these files behind the app's back — which meant a
 * full parse of the composition behind every `router.refresh()`, and the studio
 * refreshes on each edit. Stat-walking the directory costs a few dozen syscalls
 * next to that, so it is what decides whether the last parse can be reused.
 */
export function projectFingerprint(slug: string): string | null {
  const dir = projectDir(slug);
  if (!dir) return null;

  const parts: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (IGNORED_ENTRIES.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const stat = statSync(absolute);
      parts.push(`${absolute}:${stat.mtimeMs}:${stat.size}`);
    }
  };

  walk(dir);
  return parts.join("|");
}

/**
 * Remember one value per project, thrown away as soon as anything on disk
 * moves. Wraps the reads that parse HTML — the expensive ones.
 */
export function memoPerProject<T>(
  compute: (slug: string) => T,
): (slug: string) => T {
  const cache = new Map<string, { fingerprint: string; value: T }>();

  return (slug: string): T => {
    const fingerprint = projectFingerprint(slug);
    if (fingerprint === null) return compute(slug);

    const hit = cache.get(slug);
    if (hit && hit.fingerprint === fingerprint) return hit.value;

    const value = compute(slug);
    cache.set(slug, { fingerprint, value });

    // A rejected read must not be remembered as the project's state.
    if (value instanceof Promise) {
      value.catch(() => {
        if (cache.get(slug)?.value === value) cache.delete(slug);
      });
    }
    return value;
  };
}

export interface CompositionHost {
  id: string;
  src: string | null;
  start: number;
  duration: number;
  trackIndex: number;
  /** The host element, so callers can read its subtree. */
  element: Element;
}

interface CompositionClip {
  id: string;
  src: string | null;
  start: number;
  duration: number;
  trackIndex: number;
}

interface CompositionInfo {
  id: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  clips: CompositionClip[];
}

/**
 * Read the composition contract straight off the document.
 *
 * `parseHtml()`/`extractCompositionMetadata()` from @hyperframes/parsers look
 * like the API for this, but on these projects they report `resolution:
 * "portrait"` for a 1920×1080 document, a null composition id, a null duration,
 * and element names taken from inline GSAP source. The authored truth is the
 * data-* contract on the elements themselves, which `readClipTiming` decodes
 * (including legacy `data-end`/`data-layer` and `data-start` references).
 */
function readComposition(html: string): CompositionInfo {
  const { document } = parseHTML(html);
  const hosts = [...document.querySelectorAll("[data-composition-id]")];
  const root = rootHost(hosts);

  if (!root) {
    return { id: null, width: null, height: null, duration: null, clips: [] };
  }

  const rootTiming = readClipTiming(root);
  return {
    id: root.getAttribute("data-composition-id"),
    width: parseNumeric(root.getAttribute("data-width")),
    height: parseNumeric(root.getAttribute("data-height")),
    duration: rootTiming.duration ?? rootTiming.end,
    clips: nestedHosts(hosts, root).map(({ element, ...clip }) => {
      void element;
      return clip;
    }),
  };
}

function rootHost(hosts: Element[]): Element | undefined {
  return (
    hosts.find(
      (host) =>
        host.hasAttribute("data-width") && host.hasAttribute("data-height"),
    ) ?? hosts[0]
  );
}

/** Nested composition hosts, topmost track first. */
function nestedHosts(hosts: Element[], root: Element): CompositionHost[] {
  return hosts
    .filter((host) => host !== root)
    .map((host) => {
      const timing = readClipTiming(host);
      return {
        id: host.getAttribute("data-composition-id") ?? "",
        src: host.getAttribute("data-composition-src"),
        start: timing.start ?? 0,
        duration: timing.duration ?? timing.end ?? 0,
        trackIndex: timing.trackIndex,
        element: host,
      };
    })
    .sort((a, b) => b.trackIndex - a.trackIndex);
}

/** Nested composition hosts of a document — the studio's scenes. */
export function readCompositionHosts(html: string): CompositionHost[] {
  const { document } = parseHTML(html);
  const hosts = [...document.querySelectorAll("[data-composition-id]")];
  const root = rootHost(hosts);
  return root ? nestedHosts(hosts, root) : [];
}

export const readProject = memoPerProject(function readProject(
  slug: string,
): HyperframesProject | null {
  const dir = projectDir(slug);
  if (!dir) return null;

  const entry = "index.html";
  const entryPath = join(dir, entry);
  if (!existsSync(entryPath)) return null;

  const composition = readComposition(readFileSync(entryPath, "utf8"));
  const registry = readJson(join(dir, "registry-item.json"));
  const meta = readJson(join(dir, "meta.json"));
  const dimensions = registry?.dimensions as
    | { width?: number; height?: number }
    | undefined;

  return {
    slug,
    title:
      (typeof registry?.title === "string" && registry.title) ||
      (typeof meta?.name === "string" && meta.name) ||
      slug,
    description:
      typeof registry?.description === "string"
        ? registry.description
        : undefined,
    width: composition.width ?? dimensions?.width ?? 1920,
    height: composition.height ?? dimensions?.height ?? 1080,
    duration: composition.duration,
    entry,
  };
});

export function listProjects(): HyperframesProject[] {
  return listProjectSlugs()
    .map(readProject)
    .filter((project): project is HyperframesProject => project !== null);
}

/**
 * Composition HTML with the hyperframe runtime injected — the same transform
 * `hyperframes preview` applies, borrowed from @hyperframes/studio-server so
 * preview and render stay on one code path.
 */
export const buildPreviewHtml = memoPerProject(function buildPreviewHtml(
  slug: string,
): string | null {
  const dir = projectDir(slug);
  if (!dir) return null;
  return buildSubCompositionHtml(
    dir,
    "index.html",
    RUNTIME_URL,
    `/api/hf/${slug}/files/`,
  );
});

/**
 * The pre-built runtime IIFE. `loadHyperframeRuntimeSource()` is the other
 * option but it builds from `entry.ts` with esbuild and returns null for
 * published packages, so the inlined constant is the only viable path here.
 */
export function readRuntimeSource(): string {
  return getHyperframeRuntimeScript();
}

/**
 * Where a project asset lives and what it is, without reading it.
 *
 * Sub-compositions are served verbatim, the way the official studio serves
 * them. They are not standalone documents here: the runtime fetches the file
 * named by `data-composition-src` and inlines its body into the root preview.
 * Wrapping each one in a full document first — index.html's <head>, its
 * <style>, GSAP and a second runtime bootstrap — is what made scenes lay out
 * with the right geometry yet paint nothing.
 */
export function statProjectFile(
  slug: string,
  segments: string[],
): { path: string; contentType: string; size: number; mtimeMs: number } | null {
  const dir = projectDir(slug);
  if (!dir) return null;

  const target = resolveWithinProject(dir, segments.join("/"));
  if (!target || !existsSync(target)) return null;

  const stat = statSync(target);
  if (!stat.isFile()) return null;

  return {
    path: target,
    contentType: getMimeType(target),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export const readProjectTree = memoPerProject(function readProjectTree(
  slug: string,
): FileNode[] {
  const dir = projectDir(slug);
  if (!dir) return [];

  const walk = (current: string): FileNode[] => {
    const entries = readdirSync(current, { withFileTypes: true })
      .filter((entry) => !IGNORED_ENTRIES.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return entries.map((entry) => {
      const absolute = join(current, entry.name);
      const path = relative(dir, absolute).split("\\").join("/");
      return entry.isDirectory()
        ? { path, name: entry.name, kind: "folder", children: walk(absolute) }
        : { path, name: entry.name, kind: "file" };
    });
  };

  return walk(dir);
});

const TEXT_EXTENSIONS = new Set([
  "html",
  "css",
  "js",
  "mjs",
  "ts",
  "json",
  "md",
  "txt",
  "py",
  "svg",
]);

/**
 * Absolute path of an editable project file, or null when it is outside the
 * project, missing, or not a text format.
 *
 * `resolveWithinProject` is the containment check — the path arrives from the
 * browser, so `../../etc/passwd` has to resolve to null rather than to a file.
 */
function editablePath(slug: string, path: string): string | null {
  const dir = projectDir(slug);
  if (!dir) return null;

  const target = resolveWithinProject(dir, path);
  if (!target || !existsSync(target) || !statSync(target).isFile()) return null;

  const extension = path.split(".").pop() ?? "";
  return TEXT_EXTENSIONS.has(extension) ? target : null;
}

/**
 * The file's version as the editor last saw it — mtime and size.
 *
 * The agent and the SDK write these same files, so a manual save has to be able
 * to tell "nothing moved under me" from "this changed since I opened it" and
 * refuse to clobber the second case.
 */
function fileVersion(target: string): string {
  const stat = statSync(target);
  return `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`;
}

export function readSourceFile(slug: string, path: string): SourceFile | null {
  const target = editablePath(slug, path);
  if (!target) return null;

  const code = readFileSync(target, "utf8");
  return {
    path,
    code,
    foldableLines: foldableLines(code),
    saved: true,
    version: fileVersion(target),
  };
}

export function writeSourceFile(
  slug: string,
  path: string,
  code: string,
  /** Version the editor loaded; omit to force the write. */
  baseVersion?: string,
):
  | { ok: true; file: SourceFile }
  | { ok: false; error: string; status: number } {
  const target = editablePath(slug, path);
  if (!target) {
    return { ok: false, error: "file is not editable", status: 404 };
  }

  if (baseVersion && baseVersion !== fileVersion(target)) {
    return {
      ok: false,
      error: "file changed on disk since you opened it — reload before saving",
      status: 409,
    };
  }

  writeFileSync(target, code, "utf8");
  const file = readSourceFile(slug, path);
  return file
    ? { ok: true, file }
    : { ok: false, error: "write succeeded but the file could not be re-read", status: 500 };
}

/** Line numbers whose indentation opens a block — drives the fold gutter. */
function foldableLines(code: string): number[] {
  const lines = code.split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;

  return lines.reduce<number[]>((acc, line, index) => {
    const next = lines[index + 1];
    if (line.trim() && next?.trim() && indent(next) > indent(line)) {
      acc.push(index + 1);
    }
    return acc;
  }, []);
}
