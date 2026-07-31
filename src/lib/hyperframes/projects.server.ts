import "server-only";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

import type {
  FileNode,
  SourceFile,
  TimelineSection,
} from "@/lib/studio/types";

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

export function readProject(slug: string): HyperframesProject | null {
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
}

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
export function buildPreviewHtml(slug: string): string | null {
  const dir = projectDir(slug);
  if (!dir) return null;
  return buildSubCompositionHtml(
    dir,
    "index.html",
    RUNTIME_URL,
    `/api/hf/${slug}/files/`,
  );
}

/**
 * The pre-built runtime IIFE. `loadHyperframeRuntimeSource()` is the other
 * option but it builds from `entry.ts` with esbuild and returns null for
 * published packages, so the inlined constant is the only viable path here.
 */
export function readRuntimeSource(): string {
  return getHyperframeRuntimeScript();
}

export function readProjectFile(
  slug: string,
  segments: string[],
): { body: Buffer | string; contentType: string } | null {
  const dir = projectDir(slug);
  if (!dir) return null;

  const relativePath = segments.join("/");
  const target = resolveWithinProject(dir, relativePath);
  if (!target || !existsSync(target) || !statSync(target).isFile()) return null;

  // A sub-composition must be served the same way the studio serves it — with
  // the runtime injected. Handing back the raw file makes its scripts run
  // without the runtime bootstrap ("Illegal invocation" from the shader blocks).
  if (relativePath.endsWith(".html")) {
    const html = buildSubCompositionHtml(
      dir,
      relativePath,
      RUNTIME_URL,
      `/api/hf/${slug}/files/`,
    );
    if (html) return { body: html, contentType: "text/html; charset=utf-8" };
  }

  return { body: readFileSync(target), contentType: getMimeType(target) };
}

const IGNORED_ENTRIES = new Set(["node_modules", ".git", ".hyperframes"]);

export function readProjectTree(slug: string): FileNode[] {
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
}

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

export function readSourceFile(slug: string, path: string): SourceFile | null {
  const dir = projectDir(slug);
  if (!dir) return null;

  const target = resolveWithinProject(dir, path);
  if (!target || !existsSync(target) || !statSync(target).isFile()) return null;

  const extension = path.split(".").pop() ?? "";
  if (!TEXT_EXTENSIONS.has(extension)) return null;

  const code = readFileSync(target, "utf8");
  return { path, code, foldableLines: foldableLines(code), saved: true };
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

/** One track per nested composition host, labelled `<source file>:<composition id>`. */
export function readTimeline(slug: string): TimelineSection[] {
  const dir = projectDir(slug);
  if (!dir) return [];

  const entry = "index.html";
  const entryPath = join(dir, entry);
  if (!existsSync(entryPath)) return [];

  const composition = readComposition(readFileSync(entryPath, "utf8"));
  if (composition.clips.length === 0) return [];

  const rootId = composition.id ?? "root";
  return [
    {
      id: rootId,
      label: `INSIDE: ${rootId.toUpperCase()}`,
      tracks: composition.clips.map((clip) => {
        const label = `${clip.src ?? entry}:${clip.id}`;
        return {
          id: clip.id,
          label,
          visible: true,
          clips: [
            {
              id: `${clip.id}-clip`,
              label,
              start: clip.start,
              end: clip.start + clip.duration,
            },
          ],
        };
      }),
    },
  ];
}
