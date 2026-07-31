import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { readClipTiming } from "@hyperframes/core";
// resolveBlockCategory is only on the ./registry subpath, not the package root.
import { resolveBlockCategory } from "@hyperframes/core/registry";
import { parseHTML } from "linkedom";

import type { Scene, SceneBlock, SceneMedia } from "@/lib/studio/types";
import { projectPaths, readCompositionHosts } from "./projects.server";
import { readSceneScript } from "./sdk.server";
import { readNarration } from "./tts.server";

/**
 * `hyperframes add` stamps the registry item name on the first line of the file
 * it installs, which is the only local record of where a scene came from.
 */
const REGISTRY_MARKER = /<!--\s*hyperframes-registry-item:\s*([\w-]+)\s*-->/;

const MEDIA_TAGS: Record<string, SceneMedia["kind"]> = {
  IMG: "image",
  VIDEO: "video",
  AUDIO: "audio",
};

/** Resolve a media src against the composition file that references it. */
function mediaUrl(slug: string, hostFile: string, src: string): string {
  if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) return src;
  const hostDir = posix.dirname(hostFile.split("\\").join("/"));
  const resolved = posix.normalize(posix.join(hostDir, src));
  return `/api/hf/${slug}/files/${resolved.replace(/^\.\//, "")}`;
}

function collectMedia(
  slug: string,
  hostFile: string,
  root: Element,
): SceneMedia[] {
  const nodes = [...root.querySelectorAll("img, video, audio, source")];

  return nodes.flatMap((node) => {
    const tag = node.tagName.toUpperCase();
    const owner = tag === "SOURCE" ? node.parentElement : node;
    if (!owner) return [];
    const kind = MEDIA_TAGS[owner.tagName.toUpperCase()];
    if (!kind) return [];

    const src = node.getAttribute("src");
    if (!src) return [];

    const timing = readClipTiming(owner);
    return [
      {
        kind,
        src,
        url: mediaUrl(slug, hostFile, src),
        start: timing.start,
        duration: timing.duration ?? timing.end,
      },
    ];
  });
}

const blockCache = new Map<string, SceneBlock | null>();

/**
 * Look the installed block up in the registry named by hyperframes.json to get
 * its tags, then classify with the registry's own `resolveBlockCategory`. The
 * tags only exist server-side in the registry, so this is a network read; on
 * failure the scene still shows the block name, just without a category.
 */
async function readBlock(
  registryBaseUrl: string,
  name: string,
): Promise<SceneBlock | null> {
  const key = `${registryBaseUrl}#${name}`;
  const cached = blockCache.get(key);
  if (cached !== undefined) return cached;

  let block: SceneBlock | null = null;
  try {
    const response = await fetch(
      `${registryBaseUrl}/blocks/${name}/registry-item.json`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (response.ok) {
      const item = (await response.json()) as {
        title?: string;
        description?: string;
        tags?: string[];
      };
      const tags = item.tags ?? [];
      block = {
        name,
        title: item.title ?? null,
        description: item.description ?? null,
        category: resolveBlockCategory(tags),
        tags,
      };
    }
  } catch {
    block = { name, title: null, description: null, category: null, tags: [] };
  }

  blockCache.set(key, block);
  return block;
}

export async function readScenes(slug: string): Promise<Scene[]> {
  const paths = projectPaths(slug);
  if (!paths) return [];

  const { dir, entry, registryBaseUrl } = paths;
  const hosts = readCompositionHosts(readFileSync(join(dir, entry), "utf8"));

  return Promise.all(
    hosts.map(async (host) => {
      const src = host.src;
      let hostFile = entry;
      let root = host.element;
      let block: SceneBlock | null = null;

      if (src) {
        const file = join(dir, src);
        if (existsSync(file)) {
          const raw = readFileSync(file, "utf8");
          hostFile = src;
          root = parseHTML(raw).document.body;

          const marker = raw.match(REGISTRY_MARKER);
          if (marker && registryBaseUrl) {
            block = await readBlock(registryBaseUrl, marker[1]);
          } else if (marker) {
            block = {
              name: marker[1],
              title: null,
              description: null,
              category: null,
              tags: [],
            };
          }
        }
      }

      return {
        id: host.id,
        src,
        start: host.start,
        duration: host.duration,
        trackIndex: host.trackIndex,
        block,
        isTransition:
          block?.category === "transitions" ||
          (block?.tags.includes("transition") ?? false),
        media: collectMedia(slug, hostFile, root),
        // Script lines come from the SDK so each one carries the hf-id that
        // setText needs — the DOM walk here has no stable element identity.
        script: await readSceneScript(slug, { id: host.id, src }),
        narration: readNarration(slug, host.id),
      };
    }),
  );
}
