import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a small but real HyperFrames project into a workspace.
 *
 * Replaces the three prototype projects that used to be committed under
 * `projects/`. Those were kept because a real project "carries the shapes an
 * import has to survive"; what they actually carried was ~3,500 lines and a set
 * of fonts that had to be maintained to keep a handful of tests honest. This
 * writes the same shapes — a root composition with real dimensions, a mounted
 * sub-composition, an editable text element, preview settings, and the marker
 * files discovery keys on — from one place a test can read in a minute.
 *
 * Deliberately NOT a fixture directory: generated content cannot drift out of
 * sync with the parser, and a test that needs one more file adds a field here
 * instead of editing checked-in HTML.
 */

export interface SampleProjectOptions {
  /** Directory name inside the workspace; also the project's slug. */
  slug: string;
  /**
   * Identity to write into `vidcom.json`.
   *
   * Omitted writes no marker at all, which is how an unadopted folder looks.
   * Passing an id writes the **legacy** shape — id only, no platform — because
   * that is the state platform backfill exists to repair.
   */
  id?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** Seconds; the root duration and the single scene's length. */
  duration?: number;
  /** Text of the editable heading, which scene-script edits target. */
  headline?: string;
  /**
   * Write a composition the runtime builds a timeline for.
   *
   * Off by default, which keeps every existing fixture byte-identical. A
   * preview reload only completes once the runtime has posted its timeline, so
   * anything measuring or asserting a reload needs this on.
   */
  withTimeline?: boolean;
}

export interface SampleProject {
  root: string;
  slug: string;
  entry: string;
  sceneSource: string;
  sceneId: string;
  elementId: string;
}

const SCENE_ID = "scene-1";
const ELEMENT_ID = "headline";

function rootDocument(options: Required<Pick<SampleProjectOptions,
  "width" | "height" | "fps" | "duration" | "withTimeline">>): string {
  return `<!doctype html>
<html>
  <head><meta charset="UTF-8" /></head>
  <body>
    <main
      data-composition-id="main"
      data-width="${options.width}"
      data-height="${options.height}"
      data-fps="${options.fps}"
      data-duration="${options.duration}"
      data-start="0"
      ${options.withTimeline ? "" : "data-no-timeline"}
    >
      <div
        class="clip"
        data-composition-id="${SCENE_ID}"
        data-composition-src="compositions/${SCENE_ID}.html"
        data-start="0"
        data-duration="${options.duration}"
        data-track-index="1"
      ></div>
    </main>
  </body>
</html>
`;
}

function sceneDocument(options: Required<Pick<SampleProjectOptions,
  "width" | "height" | "duration" | "headline" | "withTimeline">>): string {
  return `<template id="${SCENE_ID}-template">
  <div
    data-composition-id="${SCENE_ID}"
    data-width="${options.width}"
    data-height="${options.height}"
    data-duration="${options.duration}"
    ${options.withTimeline ? "" : "data-no-timeline"}
  >
    <h1 id="${ELEMENT_ID}">${options.headline}</h1>
    <style>
      [data-composition-id="${SCENE_ID}"] {
        width: ${options.width}px;
        height: ${options.height}px;
        position: relative;
        overflow: hidden;
        background: #101014;
        font-family: system-ui, sans-serif;
      }
      [data-composition-id="${SCENE_ID}"] #${ELEMENT_ID} {
        position: absolute;
        top: 40%;
        width: 100%;
        margin: 0;
        text-align: center;
        font-size: 96px;
        color: #f5f5f0;
      }
    </style>
  </div>
</template>
`;
}

/** Preview settings in the shape `normalizePreviewSettings` accepts, with no BGM attached. */
function previewSettings(): string {
  return `${JSON.stringify({
    tone: { enabled: false },
    theme: { variables: {} },
    bgm: { enabled: false, volume: 0.3, loop: true, track: null },
    subtitles: { enabled: false },
    scenes: {},
  }, null, 2)}\n`;
}

/** Writes the project and returns the paths a test needs to act on it. */
export async function writeSampleProject(
  workspaceRoot: string,
  options: SampleProjectOptions,
): Promise<SampleProject> {
  const resolved = {
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: options.fps ?? 30,
    duration: options.duration ?? 6,
    headline: options.headline ?? "Sample project",
    withTimeline: options.withTimeline ?? false,
  };
  const root = path.join(workspaceRoot, options.slug);
  await mkdir(path.join(root, "compositions"), { recursive: true });
  await writeFile(path.join(root, "index.html"), rootDocument(resolved), "utf8");
  await writeFile(
    path.join(root, "compositions", `${SCENE_ID}.html`),
    sceneDocument(resolved),
    "utf8",
  );
  // The marker the workspace scanner keys on; a folder without it is not a
  // HyperFrames project at all.
  await writeFile(path.join(root, "hyperframes.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "preview-settings.json"), previewSettings(), "utf8");
  if (options.id !== undefined) {
    await writeFile(
      path.join(root, "vidcom.json"),
      `${JSON.stringify({ id: options.id }, null, 2)}\n`,
      "utf8",
    );
  }
  return {
    root,
    slug: options.slug,
    entry: "index.html",
    sceneSource: `compositions/${SCENE_ID}.html`,
    sceneId: SCENE_ID,
    elementId: ELEMENT_ID,
  };
}
