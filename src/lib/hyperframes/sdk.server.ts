import "server-only";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Composition, HyperFramesElement } from "@hyperframes/sdk";
import { openComposition } from "@hyperframes/sdk";

import type { Narration, SceneScriptLine } from "@/lib/studio/types";
import { projectPaths } from "./projects.server";
import { regenerateNarration } from "./tts.server";

/**
 * Open a project file as an editable composition. Headless mode (no persist
 * adapter): the SDK is a transform + serializer and this module owns the write,
 * so a failed edit never leaves a half-written file behind.
 */
async function openProjectFile(
  slug: string,
  file: string,
): Promise<{ path: string; composition: Composition } | null> {
  const paths = projectPaths(slug);
  if (!paths) return null;

  const path = join(paths.dir, file);
  if (!existsSync(path)) return null;

  return {
    path,
    composition: await openComposition(readFileSync(path, "utf8")),
  };
}

/**
 * `serialize()` re-emits the document from the DOM: `<script>`/`<style>` survive
 * verbatim, but indentation is normalised and `data-hf-id` attributes are
 * stamped in — the same trade the official studio makes when it saves.
 */
function save(path: string, composition: Composition) {
  writeFileSync(path, composition.serialize(), "utf8");
  composition.dispose();
}

/** Leaf elements carrying display text, in document order. */
function scriptLines(
  elements: readonly HyperFramesElement[],
  file: string,
  acc: SceneScriptLine[] = [],
): SceneScriptLine[] {
  for (const element of elements) {
    const tag = element.tag.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "template") continue;

    const text = (element.text ?? "").replace(/\s+/g, " ").trim();
    if (element.children.length === 0) {
      if (text.length > 1 && text.length < 400) {
        acc.push({ id: element.scopedId, text, file });
      }
      continue;
    }
    scriptLines(element.children, file, acc);
  }
  return acc;
}

function findByCompositionId(
  elements: readonly HyperFramesElement[],
  compositionId: string,
): HyperFramesElement | null {
  for (const element of elements) {
    if (element.attributes["data-composition-id"] === compositionId) {
      return element;
    }
    const nested = findByCompositionId(element.children, compositionId);
    if (nested) return nested;
  }
  return null;
}

/** Editable script lines of a scene, addressed by hf-id. */
export async function readSceneScript(
  slug: string,
  scene: { id: string; src: string | null },
): Promise<SceneScriptLine[]> {
  const paths = projectPaths(slug);
  if (!paths) return [];

  const file = scene.src ?? paths.entry;
  const opened = await openProjectFile(slug, file);
  if (!opened) return [];

  try {
    const roots = opened.composition.getRootElements();
    if (scene.src) return scriptLines(roots, file);

    // Inline scene: only the host's own subtree belongs to it.
    const host = findByCompositionId(roots, scene.id);
    return host ? scriptLines(host.children, file) : [];
  } finally {
    opened.composition.dispose();
  }
}

export async function updateSceneTiming(
  slug: string,
  sceneId: string,
  timing: { start?: number; duration?: number; trackIndex?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const paths = projectPaths(slug);
  if (!paths) return { ok: false, error: "project not found" };

  const opened = await openProjectFile(slug, paths.entry);
  if (!opened) return { ok: false, error: "composition not found" };

  const host = findByCompositionId(
    opened.composition.getRootElements(),
    sceneId,
  );
  if (!host) {
    opened.composition.dispose();
    return { ok: false, error: `scene ${sceneId} not found` };
  }

  const op = { type: "setTiming" as const, target: host.scopedId, ...timing };
  const check = opened.composition.can(op);
  if (!check.ok) {
    opened.composition.dispose();
    return { ok: false, error: check.message ?? "edit rejected by the SDK" };
  }

  opened.composition.setTiming(host.scopedId, timing);
  save(opened.path, opened.composition);
  return { ok: true };
}

export async function updateSceneScriptLine(
  slug: string,
  sceneId: string,
  file: string,
  elementId: string,
  text: string,
): Promise<{ ok: true; narration: Narration | null } | { ok: false; error: string }> {
  const opened = await openProjectFile(slug, file);
  if (!opened) return { ok: false, error: "file not found" };

  const op = { type: "setText" as const, target: elementId, value: text };
  const check = opened.composition.can(op);
  if (!check.ok) {
    opened.composition.dispose();
    return { ok: false, error: check.message ?? "edit rejected by the SDK" };
  }

  opened.composition.setText(elementId, text);
  save(opened.path, opened.composition);

  // Script changed → the narration for this scene is stale, so TTS re-runs.
  const narration = regenerateNarration(slug, sceneId, text);
  return { ok: true, narration };
}

function findRootHost(
  elements: readonly HyperFramesElement[],
): HyperFramesElement | null {
  for (const element of elements) {
    if (
      element.attributes["data-width"] &&
      element.attributes["data-height"] &&
      element.attributes["data-composition-id"]
    ) {
      return element;
    }
    const nested = findRootHost(element.children);
    if (nested) return nested;
  }
  return null;
}

/** Minimal static scene — no GSAP timeline, so nothing to register. */
function sceneCompositionHtml(
  sceneId: string,
  title: string,
  duration: number,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        width: 1920px;
        height: 1080px;
        overflow: hidden;
        background: transparent;
        font-family: "Outfit", sans-serif;
      }
      #${sceneId} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 0 12%;
      }
      #${sceneId} h2 {
        margin: 0;
        font-size: 96px;
        line-height: 1.05;
        text-align: center;
        letter-spacing: -0.02em;
      }
    </style>
  </head>
  <body>
    <div
      id="${sceneId}"
      data-composition-id="${sceneId}"
      data-width="1920"
      data-height="1080"
      data-start="0"
      data-duration="${duration}"
    >
      <h2>${escapeHtml(title)}</h2>
    </div>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Append a scene to the root composition and extend the root duration to cover
 * it. This is what the mocked Codex/MCP flow calls: the agent transcript is
 * scripted, but the scene it creates is a real edit to index.html.
 */
export async function createScene(
  slug: string,
  title: string,
  opts: { duration?: number } = {},
): Promise<
  | { ok: true; sceneId: string; start: number; duration: number; narration: Narration | null }
  | { ok: false; error: string }
> {
  const paths = projectPaths(slug);
  if (!paths) return { ok: false, error: "project not found" };

  const opened = await openProjectFile(slug, paths.entry);
  if (!opened) return { ok: false, error: "composition not found" };

  const roots = opened.composition.getRootElements();
  const root = findRootHost(roots);
  if (!root) {
    opened.composition.dispose();
    return { ok: false, error: "root composition not found" };
  }

  const hosts = root.children.filter(
    (child) => child.attributes["data-composition-id"],
  );
  const ends = hosts.map(
    (child) =>
      Number(child.attributes["data-start"] ?? 0) +
      Number(child.attributes["data-duration"] ?? 0),
  );
  const start = ends.length > 0 ? Math.max(...ends) : 0;
  const duration = opts.duration ?? 4;

  // Number only against previously generated scenes — counting overlays and
  // transition blocks as scenes makes the first generated scene "scene-6".
  const generated = hosts
    .map((child) =>
      /^scene-(\d+)$/.exec(child.attributes["data-composition-id"] ?? ""),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  const sceneId = `scene-${generated.length > 0 ? Math.max(...generated) + 1 : 1}`;
  const trackIndex =
    Math.max(
      0,
      ...hosts.map((child) => Number(child.attributes["data-track-index"] ?? 0)),
    ) + 1;

  // Each generated scene gets its own sub-composition file, the same shape the
  // scaffolded scenes use. An inline host that carries data-composition-id
  // without a src is not visibility-managed by the runtime — it renders for the
  // whole video instead of its own time range.
  const sceneFile = `compositions/${sceneId}.html`;
  mkdirSync(join(paths.dir, "compositions"), { recursive: true });
  writeFileSync(
    join(paths.dir, sceneFile),
    sceneCompositionHtml(sceneId, title, duration),
    "utf8",
  );

  const fragment =
    `<div id="${sceneId}-layer" class="comp-layer clip" data-composition-id="${sceneId}" ` +
    `data-composition-src="${sceneFile}" ` +
    `data-start="${start}" data-duration="${duration}" data-track-index="${trackIndex}"></div>`;

  const inserted = opened.composition.can({
    type: "addElement",
    parent: root.scopedId,
    index: root.children.length,
    html: fragment,
  });
  if (!inserted.ok) {
    opened.composition.dispose();
    return { ok: false, error: inserted.message ?? "insert rejected by the SDK" };
  }

  opened.composition.addElement(root.scopedId, root.children.length, fragment);

  const rootDuration = Number(root.attributes["data-duration"] ?? 0);
  if (start + duration > rootDuration) {
    opened.composition.setTiming(root.scopedId, {
      duration: start + duration,
    });
  }

  save(opened.path, opened.composition);

  return {
    ok: true,
    sceneId,
    start,
    duration,
    narration: regenerateNarration(slug, sceneId, title),
  };
}
