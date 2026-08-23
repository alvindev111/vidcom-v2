import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, posix, relative as pathRelative, sep } from "node:path";

import { parseNumeric, readClipTiming, resolveWithinProject } from "@hyperframes/core";
import { resolveBlockCategory } from "@hyperframes/core/registry";
import { openComposition, type Composition, type HyperFramesElement } from "@hyperframes/sdk";
import { parseHTML } from "linkedom";

import { ErrorCode, type ContentHash, type RelPath } from "@vidcom/contracts";
import {
  err,
  ok,
  readCues,
  type CompositionModel,
  type CompositionPort,
  type CompositionReference,
  type CompositionSource,
  type ProjectRef,
} from "@vidcom/core";

import { authoredCompositionRoot, compositionRoot, nearestHost, rootHost } from "./dom";
import { readSceneElements } from "./elements";
import { buildCompositionDocument } from "./document";
import { applyCompositionOps } from "./sdk-ops";
import type {
  CompositionHost,
  Narration,
  RootTrack,
  Scene,
  SceneBlock,
  SceneMedia,
  SceneScriptLine,
} from "./types";

const REGISTRY_MARKER = /<!--\s*hyperframes-registry-item:\s*([\w-]+)\s*-->/;
const MEDIA_TAGS: Record<string, SceneMedia["kind"]> = { IMG: "image", VIDEO: "video", AUDIO: "audio" };
const blockCache = new Map<string, SceneBlock | null>();
const SCENE_ROLES = new Set<Scene["role"]>(["root", "story", "transition", "overlay", "credit", "utility"]);
const STORY_PATTERNS_EXCLUDED = new Set(["fade", "slide", "cards"]);
const STORY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const SEAM_KINDS = new Set<NonNullable<Scene["seam"]>["kind"]>(["carry", "transform", "contrast"]);
const PROJECT_URL_ROOT = new URL("https://vidcom.invalid/__project__/");
const PROJECT_URL_PREFIX = PROJECT_URL_ROOT.pathname;

function sourceFromRaw(path: RelPath, raw: string): CompositionSource {
  return {
    path,
    contentHash: `sha256:${createHash("sha256").update(raw).digest("hex")}` as ContentHash,
    byteSize: new TextEncoder().encode(raw).byteLength,
  };
}

function canonicalProjectReference(owner: RelPath, raw: string | null): RelPath | null {
  if (!raw) return null;
  const value = raw.trim().split("\\").join("/");
  if (!value || value.startsWith("/") || value.startsWith("//")
    || value.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  try {
    const base = new URL(owner, PROJECT_URL_ROOT);
    const parsed = new URL(value, base);
    if (parsed.origin !== PROJECT_URL_ROOT.origin || !parsed.pathname.startsWith(PROJECT_URL_PREFIX)) return null;
    const pathname = decodeURIComponent(parsed.pathname.slice(PROJECT_URL_PREFIX.length));
    const resolved = posix.normalize(pathname).replace(/^\.\//, "");
    return !resolved || resolved === ".." || resolved.startsWith("../") ? null : resolved as RelPath;
  } catch {
    return null;
  }
}

function isExternalMediaReference(raw: string): boolean {
  const value = raw.trim();
  return value.startsWith("//") || /^(?:https?|data|blob):/iu.test(value);
}

function projectAssetUrl(ref: ProjectRef, relative: RelPath): string {
  const path = relative.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `/api/v1/projects/${encodeURIComponent(ref.id)}/assets/${path}`;
}

function collectProjectReferences(
  entry: RelPath,
  scenes: Scene[],
  rootTrack: RootTrack | null,
  entryMedia: readonly SceneMedia[],
  sources: readonly CompositionSource[],
): CompositionReference[] {
  const availableSources = new Set(sources.map(({ path }) => path));
  const references = new Map<string, CompositionReference>();
  const add = (owner: RelPath, raw: string | null) => {
    const referenced = canonicalProjectReference(owner, raw);
    if (referenced) references.set(`${owner}\0${referenced}`, { owner, path: referenced });
    return referenced;
  };
  for (const scene of scenes) {
    const source = add(entry, scene.src);
    const owner = source && availableSources.has(source) ? source : entry;
    for (const media of scene.media) add(owner, media.src);
    for (const element of scene.elements) add(owner, element.src);
    // Narration sidecars store project-relative paths. Unlike media authored in
    // a scene HTML file, their audio path is not relative to the scene source.
    if (scene.narration?.status === "generated") add(entry, scene.narration.audioPath);
  }
  for (const media of entryMedia) add(entry, media.src);
  for (const element of rootTrack?.elements ?? []) add(entry, element.src);
  return [...references.values()];
}

function readJson(filename: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function safeProjectFile(ref: ProjectRef, relativePath: string): string | null {
  const target = resolveWithinProject(ref.root, relativePath);
  if (!target || !existsSync(target)) return null;
  try {
    const root = realpathSync(ref.root);
    const canonical = realpathSync(target);
    const relative = pathRelative(root, canonical);
    const contained = relative === ""
      || (!relative.startsWith(`..${sep}`) && relative !== ".." && !isAbsolute(relative));
    return contained && statSync(canonical).isFile() ? canonical : null;
  } catch {
    return null;
  }
}

function compositionHosts(authoredRoot: ParentNode): { root: Element | null; hosts: CompositionHost[] } {
  const elements = [...authoredRoot.querySelectorAll("[data-composition-id]")];
  const root = rootHost(elements) ?? null;
  if (!root) return { root, hosts: [] };
  return {
    root,
    hosts: elements
      .filter((element) => element !== root)
      .map((element) => {
        const timing = readClipTiming(element);
        return {
          id: element.getAttribute("data-composition-id") ?? "",
          src: element.getAttribute("data-composition-src"),
          start: timing.start ?? 0,
          duration: timing.duration ?? timing.end ?? 0,
          trackIndex: timing.trackIndex,
          element,
        };
      })
      .sort((left, right) => right.trackIndex - left.trackIndex),
  };
}

function scriptLines(
  elements: readonly HyperFramesElement[],
  file: string,
  accumulator: SceneScriptLine[] = [],
): SceneScriptLine[] {
  for (const element of elements) {
    const tag = element.tag.toLowerCase();
    if (["script", "style", "template"].includes(tag)) continue;
    const value = (element.text ?? "").replace(/\s+/g, " ").trim();
    if (element.children.length === 0) {
      if (value.length > 1 && value.length < 400) accumulator.push({ id: element.scopedId, text: value, file });
    } else {
      scriptLines(element.children, file, accumulator);
    }
  }
  return accumulator;
}

function findCompositionElement(
  elements: readonly HyperFramesElement[],
  compositionId: string,
): HyperFramesElement | null {
  for (const element of elements) {
    if (element.attributes["data-composition-id"] === compositionId) return element;
    const nested = findCompositionElement(element.children, compositionId);
    if (nested) return nested;
  }
  return null;
}

function sceneScriptLines(composition: Composition, file: string, scene: { id: string; src: string | null }) {
  const roots = composition.getRootElements();
  if (scene.src) return scriptLines(roots, file);
  const host = findCompositionElement(roots, scene.id);
  return host ? scriptLines(host.children, file) : [];
}

function collectMedia(ref: ProjectRef, hostFile: string, root: ParentNode): SceneMedia[] {
  return [...root.querySelectorAll("img, video, audio, source")].flatMap((node) => {
    const owner = node.tagName.toUpperCase() === "SOURCE" ? node.parentElement : node;
    if (!owner) return [];
    const kind = MEDIA_TAGS[owner.tagName.toUpperCase()];
    const src = node.getAttribute("src");
    if (!kind || !src) return [];
    const timing = readClipTiming(owner);
    const external = isExternalMediaReference(src);
    const relative = external ? null : canonicalProjectReference(hostFile as RelPath, src);
    return [{
      kind,
      src,
      url: external || relative === null ? src : projectAssetUrl(ref, relative),
      start: timing.start,
      duration: timing.duration ?? timing.end,
      // Only a file this project owns can be missing; a remote source is not
      // ours to find, and saying it is gone would be a false alarm.
      missing: !external && (relative === null || safeProjectFile(ref, relative) === null),
    }];
  });
}

function readNarration(ref: ProjectRef, sceneId: string): Narration | null {
  const filename = safeProjectFile(ref, `narration/${sceneId}.json`);
  if (!filename) return null;
  try {
    const raw = JSON.parse(readFileSync(filename, "utf8")) as Narration & {
      cues?: unknown; revision?: number; updatedAt?: string;
    };
    if (Array.isArray(raw.cues)) {
      const cue = readCues(raw)[0];
      if (!cue?.audioPath) return null;
      return {
        sceneId,
        text: cue.text,
        voice: cue.voice,
        status: safeProjectFile(ref, cue.audioPath) ? "generated" : "mock",
        audioPath: cue.audioPath,
        command: cue.command ?? "",
        revision: typeof raw.revision === "number" ? raw.revision : 0,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
        staleSince: cue.staleSince,
        ...(cue.durationSeconds ? { durationSeconds: cue.durationSeconds } : {}),
        ...(cue.words ? { words: cue.words } : {}),
        ...(cue.wordTimingSource ? { wordTimingSource: cue.wordTimingSource } : {}),
      };
    }
    const narration = raw;
    return {
      ...narration,
      status: safeProjectFile(ref, narration.audioPath) ? "generated" : "mock",
      staleSince: typeof narration.staleSince === "string" ? narration.staleSince : null,
    };
  } catch {
    return null;
  }
}

async function readBlock(baseUrl: string | null, raw: string): Promise<SceneBlock | null> {
  const marker = raw.match(REGISTRY_MARKER);
  if (!marker) return null;
  const name = marker[1];
  const fallback: SceneBlock = { name, title: null, description: null, category: null, tags: [] };
  if (!baseUrl) return fallback;
  const key = `${baseUrl}#${name}`;
  if (blockCache.has(key)) return blockCache.get(key) ?? null;
  try {
    const response = await fetch(`${baseUrl}/blocks/${name}/registry-item.json`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return fallback;
    const item = await response.json() as { title?: string; description?: string; tags?: string[] };
    const tags = item.tags ?? [];
    const block = {
      name,
      title: item.title ?? null,
      description: item.description ?? null,
      category: resolveBlockCategory(tags),
      tags,
    };
    blockCache.set(key, block);
    return block;
  } catch {
    return fallback;
  }
}

async function parseScenes(
  ref: ProjectRef,
  entryRaw: string,
  authoredRoot: ParentNode,
  hosts: CompositionHost[],
  registryBaseUrl: string | null,
  recordSource: (path: RelPath, raw: string) => void,
): Promise<Scene[]> {
  const compositions = new Map<string, Promise<Composition>>();
  const open = (file: string, raw: string) => {
    const pending = compositions.get(file) ?? openComposition(raw);
    compositions.set(file, pending);
    return pending;
  };
  try {
    return await Promise.all(hosts.map(async (host): Promise<Scene> => {
      let hostFile = ref.entry;
      let raw = entryRaw;
      let root: ParentNode = host.element;
      if (host.src) {
        const filename = safeProjectFile(ref, host.src);
        if (filename) {
          hostFile = host.src as typeof ref.entry;
          raw = readFileSync(filename, "utf8");
          recordSource(hostFile, raw);
          root = compositionRoot(raw);
        }
      }
      const scriptFile = host.src ? (hostFile === host.src ? hostFile : null) : ref.entry;
      const composition = scriptFile ? await open(scriptFile, raw) : null;
      const ownScript = composition && scriptFile ? sceneScriptLines(composition, scriptFile, host) : [];
      const catalogHost = host.src
        ? root.querySelector?.("[data-catalog-provenance][data-composition-src]") ?? null
        : null;
      const catalogSource = catalogHost
        ? canonicalProjectReference(hostFile, catalogHost.getAttribute("data-composition-src"))
        : null;
      let catalogScript: SceneScriptLine[] = [];
      if (catalogSource) {
        const filename = safeProjectFile(ref, catalogSource);
        if (filename) {
          const catalogRaw = readFileSync(filename, "utf8");
          recordSource(catalogSource, catalogRaw);
          const catalogComposition = await open(catalogSource, catalogRaw);
          catalogScript = sceneScriptLines(catalogComposition, catalogSource, {
            id: host.id,
            src: catalogSource,
          });
        }
      }
      const block = await readBlock(registryBaseUrl, raw);
      const isTransition = block?.category === "transitions" || (block?.tags.includes("transition") ?? false);
      const metadata = root.querySelector?.(`[data-composition-id="${host.id}"]`) ?? host.element;
      const authoredRole = metadata.getAttribute("data-scene-role") as Scene["role"] | null;
      const role = authoredRole && SCENE_ROLES.has(authoredRole)
        ? authoredRole
        : isTransition
          ? "transition"
          : block?.tags.includes("overlay") || /overlay/iu.test(host.id)
            ? "overlay"
            : "story";
      const authoredPattern = metadata.getAttribute("data-story-pattern");
      const storyPattern = authoredPattern && STORY_PATTERN.test(authoredPattern)
          && !STORY_PATTERNS_EXCLUDED.has(authoredPattern)
        ? authoredPattern
        : null;
      const authoredSeamKind = metadata.getAttribute("data-seam-kind") as NonNullable<Scene["seam"]>["kind"] | null;
      const authoredSeamToken = metadata.getAttribute("data-seam-token")?.trim() ?? "";
      const seam = authoredSeamKind && SEAM_KINDS.has(authoredSeamKind)
          && authoredSeamToken.length > 0 && authoredSeamToken.length <= 80
        ? { kind: authoredSeamKind, token: authoredSeamToken }
        : null;
      return {
        id: host.id,
        src: host.src,
        sourceFile: hostFile,
        role,
        storyPattern,
        seam,
        start: host.start,
        duration: host.duration,
        trackIndex: host.trackIndex,
        block,
        isTransition,
        media: collectMedia(ref, hostFile, root),
        script: [...ownScript, ...catalogScript],
        narration: readNarration(ref, host.id),
        ...readSceneElements(root, host.id, () => true, host.src ? undefined : authoredRoot),
      };
    }));
  } finally {
    for (const pending of compositions.values()) void pending.then((composition) => composition.dispose());
  }
}

function parseRootTrack(authoredRoot: ParentNode, root: Element | null): RootTrack | null {
  if (!root) return null;
  const timing = readClipTiming(root);
  const parsed = readSceneElements(authoredRoot, root.getAttribute("data-composition-id") ?? "root", (node) => {
    const owner = nearestHost(node);
    return owner === null || owner === root;
  });
  return parsed.elements.length === 0 && parsed.unresolvedEffects === 0
    ? null
    : {
        id: root.getAttribute("data-composition-id") ?? "root",
        duration: timing.duration ?? timing.end ?? 0,
        ...parsed,
      };
}

/** Synchronous compatibility read for the legacy RSC while the API snapshot is not cut over. */
export function readRootTrackFromProject(ref: ProjectRef): RootTrack | null {
  const entry = safeProjectFile(ref, ref.entry);
  if (!entry) return null;
  const { document } = parseHTML(readFileSync(entry, "utf8"));
  const authoredRoot = authoredCompositionRoot(document);
  return parseRootTrack(authoredRoot, compositionHosts(authoredRoot).root);
}

/** HyperFrames adapter that aggregates project, scenes and root track from one entry parse. */
export class CompositionHf implements CompositionPort {
  async validateSource(file: RelPath, content: string) {
    if (!file.toLowerCase().endsWith(".html")) return ok(undefined);
    let composition: Composition | null = null;
    try {
      composition = await openComposition(content);
      const containsHost = (elements: readonly HyperFramesElement[]): boolean => elements.some((element) =>
        Boolean(element.attributes["data-composition-id"]) || containsHost(element.children),
      );
      return containsHost(composition.getRootElements())
        ? ok(undefined)
        : err({ code: ErrorCode.SdkRejected, message: "composition source has no data-composition-id host" });
    } catch {
      return err({ code: ErrorCode.SdkRejected, message: "composition source could not be parsed" });
    } finally {
      composition?.dispose();
    }
  }

  async parseProject(ref: ProjectRef): Promise<CompositionModel> {
    const entry = safeProjectFile(ref, ref.entry);
    if (!entry) throw new Error("project entry does not exist");
    const entryRaw = readFileSync(entry, "utf8");
    const sources = new Map<RelPath, CompositionSource>();
    const recordSource = (path: RelPath, raw: string) => {
      if (!sources.has(path)) sources.set(path, sourceFromRaw(path, raw));
    };
    recordSource(ref.entry, entryRaw);
    const { document } = parseHTML(entryRaw);
    const authoredRoot = authoredCompositionRoot(document);
    const { root, hosts } = compositionHosts(authoredRoot);
    const timing = root ? readClipTiming(root) : { duration: null, end: null };
    const registry = readJson(join(ref.root, "registry-item.json"));
    const meta = readJson(join(ref.root, "meta.json"));
    const config = readJson(join(ref.root, "hyperframes.json"));
    const dimensions = registry?.dimensions as { width?: number; height?: number } | undefined;
    const scenes = await parseScenes(
      ref,
      entryRaw,
      authoredRoot,
      hosts,
      typeof config?.registry === "string" ? config.registry.replace(/\/$/, "") : null,
      recordSource,
    );
    const rootTrack = parseRootTrack(authoredRoot, root);
    const entryMedia = collectMedia(ref, ref.entry, authoredRoot);
    const sourceList = [...sources.values()];
    const stat = statSync(entry);
    return {
      project: {
        id: ref.id,
        slug: ref.slug,
        title: (typeof registry?.title === "string" && registry.title)
          || (typeof meta?.name === "string" && meta.name)
          || ref.slug,
        ...(typeof registry?.description === "string" ? { description: registry.description } : {}),
        width: root ? parseNumeric(root.getAttribute("data-width")) ?? dimensions?.width ?? 1920 : dimensions?.width ?? 1920,
        height: root ? parseNumeric(root.getAttribute("data-height")) ?? dimensions?.height ?? 1080 : dimensions?.height ?? 1080,
        duration: timing.duration ?? timing.end ?? 0,
        updatedAt: stat.mtime.toISOString(),
        sceneCount: scenes.length,
        revision: 0,
      },
      frameRate: root ? parseNumeric(root.getAttribute("data-fps")) ?? 30 : 30,
      agentKitVersion: Number.isSafeInteger(config?.vidcomAgentKitVersion)
        && Number(config?.vidcomAgentKitVersion) >= 0
        ? Number(config?.vidcomAgentKitVersion)
        : null,
      scenes,
      rootTrack,
      diagnostics: [],
      sources: sourceList,
      references: collectProjectReferences(ref.entry, scenes, rootTrack, entryMedia, sourceList),
    };
  }

  buildDocument(
    ref: ProjectRef,
    settings: Parameters<CompositionPort["buildDocument"]>[1],
    options: Parameters<CompositionPort["buildDocument"]>[2],
  ) {
    return buildCompositionDocument(ref, settings, options);
  }

  applyOps(ref: ProjectRef, file: Parameters<CompositionPort["applyOps"]>[1], operations: Parameters<CompositionPort["applyOps"]>[2]) {
    return applyCompositionOps(ref, file, operations);
  }
}
