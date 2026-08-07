/**
 * S1b — does the in-process HyperFrames path survive Node SEA?
 *
 * Mirrors the imports the adapter actually makes today (parse.ts, sdk-ops.ts,
 * document.ts, elements.ts, runtime.ts) rather than a reduced sample: the
 * question is whether *those* call sites bundle, not whether some subset does.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseNumeric, readClipTiming, resolveWithinProject, getHyperframeRuntimeScript } from "@hyperframes/core";
import { resolveBlockCategory } from "@hyperframes/core/registry";
import { openComposition } from "@hyperframes/sdk";
import { buildSubCompositionHtml } from "@hyperframes/studio-server";
import { parseGsapScript } from "@hyperframes/parsers/gsap-parser";
import { parseHTML } from "linkedom";

const verdict = { steps: {}, execPath: process.execPath, cwd: process.cwd() };

function step(name, fn) {
  try {
    verdict.steps[name] = { ok: true, value: fn() };
  } catch (error) {
    verdict.steps[name] = { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function stepAsync(name, fn) {
  try {
    verdict.steps[name] = { ok: true, value: await fn() };
  } catch (error) {
    verdict.steps[name] = { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

const projectRoot = process.argv[2];
const compositionFile = process.argv[3] ?? "index.html";
const outFile = process.argv[4];

step("resolveWithinProject", () => resolveWithinProject(projectRoot, compositionFile));
step("parseNumeric", () => parseNumeric("12.5s"));
step("resolveBlockCategory", () => resolveBlockCategory("text") ?? null);
step("linkedom", () => {
  const { document } = parseHTML("<div data-clip-start='1s'>x</div>");
  return document.querySelector("div")?.getAttribute("data-clip-start") ?? null;
});
step("runtimeScript", () => {
  const script = getHyperframeRuntimeScript();
  return typeof script === "string" ? script.length : typeof script;
});
step("parseGsapScript", () => {
  const parsed = parseGsapScript("gsap.to('.a', { duration: 1, x: 10 });");
  return Array.isArray(parsed) ? parsed.length : typeof parsed;
});

const source = readFileSync(path.join(projectRoot, compositionFile), "utf8");

// Wrapped in a function: Node SEA takes a CJS main, and esbuild refuses
// top-level await for the cjs output format. This constraint is a finding.
async function main() {
await stepAsync("openComposition", async () => {
  const composition = await openComposition(source);
  const roots = composition.getRootElements();
  return { rootElements: roots.length };
});

// readClipTiming takes a DOM element, the way dom.ts and parse.ts call it.
step("readClipTiming", () => {
  const { document } = parseHTML(source);
  const clips = [...document.querySelectorAll(".clip, [data-clip-start], [data-composition-id]")];
  const timings = clips.map((element) => readClipTiming(element));
  return { clips: clips.length, first: timings[0] ?? null };
});

await stepAsync("editAndSerialize", async () => {
  const composition = await openComposition(source);
  const findLeaf = (elements) => {
    for (const element of elements) {
      const children = element.children ?? [];
      if (children.length === 0) return element.scopedId;
      const nested = findLeaf(children);
      if (nested) return nested;
    }
    return null;
  };
  const targetId = findLeaf(composition.getRootElements());
  if (!targetId) throw new Error("no leaf element to edit");
  const op = { type: "setText", target: targetId, value: "S1B-EDITED" };
  const allowed = composition.can(op);
  if (!allowed.ok) throw new Error(`SDK rejected the edit: ${JSON.stringify(allowed)}`);
  composition.dispatch(op);
  const html = composition.serialize();
  composition.dispose();
  if (outFile) writeFileSync(outFile, html, "utf8");
  return { target: targetId, edited: html.includes("S1B-EDITED"), bytes: html.length };
});

// Same four-argument shape buildHyperframesBaseDocument uses (document.ts:41).
await stepAsync("buildSubCompositionHtml", async () => {
  const html = await buildSubCompositionHtml(projectRoot, compositionFile, "/runtime.js", "/files/");
  return typeof html === "string" ? html.length : typeof html;
});

}

main().then(() => {
  verdict.pass = Object.values(verdict.steps).every((s) => s.ok);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(verdict.pass ? 0 : 1);
});
