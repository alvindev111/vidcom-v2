import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import {
  getHyperframeRuntimeScript,
  parseNumeric,
  readClipTiming,
  resolveWithinProject,
} from "@hyperframes/core";
import { getMimeType } from "@hyperframes/studio-server";
import { parseHTML } from "linkedom";

import type { ProjectId, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, ProjectRef } from "@vidcom/core";

import { rootHost } from "./dom";
import { buildHyperframesBaseDocument } from "./document";

const IGNORED = new Set(["node_modules", ".git", ".hyperframes"]);
const TEXT_EXTENSIONS = new Set(["html", "css", "js", "mjs", "ts", "json", "md", "txt", "py", "svg"]);

export interface LegacyProject {
  slug: string;
  title: string;
  description?: string;
  width: number;
  height: number;
  duration: number | null;
  entry: string;
}
export interface LegacyFileNode { path: string; name: string; kind: "file" | "folder"; children?: LegacyFileNode[] }
export interface LegacySourceFile {
  path: string; code: string; foldableLines: number[]; saved: boolean; version: string;
}

function json(filename: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown>; } catch { return null; }
}

/** Injected-root compatibility adapter used only while legacy Next routes remain. */
export class LegacyHyperframesProjects {
  constructor(
    readonly projectsRoot: string,
    readonly runtimeUrl = "/api/hf/runtime",
  ) {}

  projectDir(slug: string): string | null {
    const directory = resolveWithinProject(this.projectsRoot, slug);
    return directory && existsSync(join(directory, "hyperframes.json")) ? directory : null;
  }

  projectPaths(slug: string): { dir: string; entry: string; registryBaseUrl: string | null } | null {
    const dir = this.projectDir(slug);
    if (!dir) return null;
    const config = json(join(dir, "hyperframes.json"));
    return {
      dir,
      entry: "index.html",
      registryBaseUrl: typeof config?.registry === "string" ? config.registry.replace(/\/$/, "") : null,
    };
  }

  readProjectRef(slug: string): ProjectRef | null {
    const paths = this.projectPaths(slug);
    if (!paths) return null;
    const identity = json(join(paths.dir, "vidcom.json"));
    return {
      id: (typeof identity?.id === "string" ? identity.id : slug) as ProjectId,
      slug,
      root: paths.dir as AbsolutePath,
      entry: paths.entry as RelPath,
    };
  }

  listProjectSlugs(): string[] {
    if (!existsSync(this.projectsRoot)) return [];
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && this.projectDir(entry.name) !== null)
      .map((entry) => entry.name)
      .sort();
  }

  projectFingerprint(slug: string): string | null {
    const directory = this.projectDir(slug);
    if (!directory) return null;
    const parts: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (IGNORED.has(entry.name)) continue;
        const absolute = join(current, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else {
          const stat = statSync(absolute);
          parts.push(`${absolute}:${stat.mtimeMs}:${stat.size}`);
        }
      }
    };
    walk(directory);
    return parts.join("|");
  }

  memoPerProject<Value>(compute: (slug: string) => Value): (slug: string) => Value {
    const cache = new Map<string, { fingerprint: string; value: Value }>();
    return (slug) => {
      const fingerprint = this.projectFingerprint(slug);
      if (fingerprint === null) return compute(slug);
      const hit = cache.get(slug);
      if (hit?.fingerprint === fingerprint) return hit.value;
      const value = compute(slug);
      cache.set(slug, { fingerprint, value });
      if (value instanceof Promise) value.catch(() => {
        if (cache.get(slug)?.value === value) cache.delete(slug);
      });
      return value;
    };
  }

  readProject(slug: string): LegacyProject | null {
    const paths = this.projectPaths(slug);
    if (!paths) return null;
    const entryPath = join(paths.dir, paths.entry);
    if (!existsSync(entryPath)) return null;
    const { document } = parseHTML(readFileSync(entryPath, "utf8"));
    const root = rootHost([...document.querySelectorAll("[data-composition-id]")]);
    const timing = root ? readClipTiming(root) : null;
    const registry = json(join(paths.dir, "registry-item.json"));
    const meta = json(join(paths.dir, "meta.json"));
    const dimensions = registry?.dimensions as { width?: number; height?: number } | undefined;
    return {
      slug,
      title: (typeof registry?.title === "string" && registry.title)
        || (typeof meta?.name === "string" && meta.name)
        || slug,
      ...(typeof registry?.description === "string" ? { description: registry.description } : {}),
      width: root ? parseNumeric(root.getAttribute("data-width")) ?? dimensions?.width ?? 1920 : dimensions?.width ?? 1920,
      height: root ? parseNumeric(root.getAttribute("data-height")) ?? dimensions?.height ?? 1080 : dimensions?.height ?? 1080,
      duration: timing?.duration ?? timing?.end ?? null,
      entry: paths.entry,
    };
  }

  listProjects(): LegacyProject[] {
    return this.listProjectSlugs().map((slug) => this.readProject(slug)).filter((item): item is LegacyProject => item !== null);
  }

  buildPreviewHtml(slug: string): string | null {
    const paths = this.projectPaths(slug);
    return paths
      ? buildHyperframesBaseDocument(paths.dir, paths.entry, this.runtimeUrl, `/api/hf/${slug}/files/`)
      : null;
  }

  readRuntimeSource(): string { return getHyperframeRuntimeScript(); }

  statProjectFile(slug: string, segments: string[]) {
    const directory = this.projectDir(slug);
    const target = directory ? resolveWithinProject(directory, segments.join("/")) : null;
    if (!target || !existsSync(target)) return null;
    const stat = statSync(target);
    return stat.isFile()
      ? { path: target, contentType: getMimeType(target), size: stat.size, mtimeMs: stat.mtimeMs }
      : null;
  }

  readProjectTree(slug: string): LegacyFileNode[] {
    const directory = this.projectDir(slug);
    if (!directory) return [];
    const walk = (current: string): LegacyFileNode[] => readdirSync(current, { withFileTypes: true })
      .filter((entry) => !IGNORED.has(entry.name))
      .sort((a, b) => a.isDirectory() !== b.isDirectory()
        ? (a.isDirectory() ? -1 : 1)
        : a.name.localeCompare(b.name))
      .map((entry) => {
        const absolute = join(current, entry.name);
        const pathname = relative(directory, absolute).split("\\").join("/");
        return entry.isDirectory()
          ? { path: pathname, name: entry.name, kind: "folder", children: walk(absolute) }
          : { path: pathname, name: entry.name, kind: "file" };
      });
    return walk(directory);
  }

  private editablePath(slug: string, pathname: string): string | null {
    const directory = this.projectDir(slug);
    const target = directory ? resolveWithinProject(directory, pathname) : null;
    const extension = pathname.split(".").pop() ?? "";
    return target && existsSync(target) && statSync(target).isFile() && TEXT_EXTENSIONS.has(extension) ? target : null;
  }

  readSourceFile(slug: string, pathname: string): LegacySourceFile | null {
    const target = this.editablePath(slug, pathname);
    if (!target) return null;
    const code = readFileSync(target, "utf8");
    const stat = statSync(target);
    const lines = code.split("\n");
    const indent = (line: string) => line.length - line.trimStart().length;
    return {
      path: pathname,
      code,
      foldableLines: lines.reduce<number[]>((result, line, index) => {
        const next = lines[index + 1];
        if (line.trim() && next?.trim() && indent(next) > indent(line)) result.push(index + 1);
        return result;
      }, []),
      saved: true,
      version: `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`,
    };
  }

  writeSourceFile(slug: string, pathname: string, code: string, baseVersion?: string) {
    const target = this.editablePath(slug, pathname);
    if (!target) return { ok: false as const, error: "file is not editable", status: 404 };
    const stat = statSync(target);
    const currentVersion = `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`;
    const currentHash = `sha256:${createHash("sha256").update(readFileSync(target)).digest("hex")}`;
    if (baseVersion && baseVersion !== currentVersion && baseVersion !== currentHash) {
      return {
        ok: false as const,
        error: "file changed on disk since you opened it — reload before saving",
        status: 409,
      };
    }
    writeFileSync(target, code, "utf8");
    const file = this.readSourceFile(slug, pathname);
    return file
      ? { ok: true as const, file }
      : { ok: false as const, error: "write succeeded but the file could not be re-read", status: 500 };
  }
}
