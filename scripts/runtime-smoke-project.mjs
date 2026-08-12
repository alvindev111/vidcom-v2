import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SLUG = "runtime-smoke";
const PROJECT_ID = "project_runtime_smoke";
const SCENE_ID = "scene-1";

/** Writes the real marker-backed HyperFrames project exercised by runtime smoke. */
export async function writeRuntimeSmokeProject(workspace) {
  const project = path.join(workspace, SLUG);
  await mkdir(path.join(project, "compositions"), { recursive: true });
  await Promise.all([
    writeFile(path.join(project, "index.html"), `<!doctype html>
<html>
  <head><meta charset="UTF-8" /></head>
  <body>
    <main data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="6" data-start="0" data-no-timeline>
      <div class="clip" data-composition-id="${SCENE_ID}" data-composition-src="compositions/${SCENE_ID}.html" data-start="0" data-duration="6" data-track-index="1"></div>
    </main>
  </body>
</html>
`, "utf8"),
    writeFile(path.join(project, "compositions", `${SCENE_ID}.html`), `<template id="${SCENE_ID}-template">
  <div data-composition-id="${SCENE_ID}" data-width="1920" data-height="1080" data-duration="6" data-no-timeline>
    <h1 id="headline">Runtime smoke</h1>
  </div>
</template>
`, "utf8"),
    writeFile(path.join(project, "hyperframes.json"), "{}\n", "utf8"),
    writeFile(path.join(project, "preview-settings.json"), `${JSON.stringify({
      tone: { enabled: false },
      theme: { variables: {} },
      bgm: { enabled: false, volume: 0.3, loop: true, track: null },
      subtitles: { enabled: false },
      scenes: {},
    }, null, 2)}\n`, "utf8"),
    writeFile(
      path.join(project, "vidcom.json"),
      `${JSON.stringify({ id: PROJECT_ID }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return Object.freeze({ project, slug: SLUG, id: PROJECT_ID, entry: path.join(project, "index.html") });
}
