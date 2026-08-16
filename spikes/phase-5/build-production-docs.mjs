// Builds preview documents with the SAME builder production uses
// (`buildSubCompositionHtml`, wrapped by packages/adapter/src/hyperframes/document.ts).
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const { buildSubCompositionHtml } = await import("@hyperframes/studio-server");

const here = new URL(".", import.meta.url).pathname;
const projectRoot = join(here, "project");
const outDir = join(here, "compiled");
await mkdir(outDir, { recursive: true });

const RUNTIME_URL = "/vendor/hyperframe.runtime.iife.js";
const FILE_BASE = "/project-files/";

const targets = [
  { entry: "index.html", out: "root.html" },
  { entry: "compositions/scene-1.html", out: "scene-1.html" },
  { entry: "compositions/scene-1-v2.html", out: "scene-1-v2.html" },
  { entry: "compositions/scene-1-assets.html", out: "scene-1-assets.html" },
  { entry: "index-v2.html", out: "root-v2.html" },
  { entry: "index-broken.html", out: "root-broken.html" },
  { entry: "index-short.html", out: "root-short.html" },
  { entry: "index-missing.html", out: "root-missing.html" },
  { entry: "index-rooterror.html", out: "root-rooterror.html" },
];

const report = [];
for (const target of targets) {
  const built = buildSubCompositionHtml(projectRoot, target.entry, RUNTIME_URL, FILE_BASE);
  // The health collector must be the FIRST authored-independent head script: attached
  // from the host it is too late because an authored root script runs during parse
  // (measured, round 5 S-P20). Production Design gives preview its own
  // injectHealthCollectorDocument path; the render-only runtime guard is separate.
  const collector = `<script data-vidcom-health="1">(()=>{const h={scriptErrors:0,rejections:0,resourceErrors:0};`
    + `window.__vidcomHealth=h;`
    + `window.addEventListener("error",e=>{if(e.target&&e.target!==window)h.resourceErrors++;else h.scriptErrors++;},true);`
    + `window.addEventListener("unhandledrejection",()=>{h.rejections++;});})();<\/script>`;
  const html = typeof built === "string"
    ? built.replace(/<head[^>]*>/iu, (head) => `${head}\n${collector}`)
    : built;
  if (typeof html !== "string") {
    report.push({ ...target, ok: false, note: "builder returned null" });
    continue;
  }
  await writeFile(join(outDir, target.out), html);
  report.push({
    ...target,
    ok: true,
    bytes: html.length,
    inlinedSceneOne: html.includes("scene-1-title"),
    hasRuntimeScript: html.includes(RUNTIME_URL),
    scopedStyleMarkers: (html.match(/data-hf-[a-z-]+/gu) ?? []).slice(0, 6),
  });
}
console.log(JSON.stringify(report, null, 2));
