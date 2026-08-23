import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HyperframesCompositionDependencyGraph } from "@vidcom/adapter";
import { ErrorCode, type ProjectId, type RelPath } from "@vidcom/contracts";
import type { AbsolutePath, ProjectRef } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<ProjectRef> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-dependencies-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content, "utf8");
  }
  return {
    id: "project_dependencies" as ProjectId,
    slug: "dependencies",
    root: root as AbsolutePath,
    entry: "index.html" as RelPath,
  };
}

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("HyperframesCompositionDependencyGraph", () => {
  it("walks canonical HTML, CSS, font and JavaScript dependencies once across cycles", async () => {
    const ref = await project({
      "index.html": `<main data-composition-id="main"><div data-composition-id="scene-a" data-composition-src="scenes/a.html"></div></main>`,
      "scenes/a.html": `<template><section data-composition-id="scene-a"><link rel="stylesheet" href="styles/a.css"><img src="media/poster.png"><script type="module" src="scripts/a.js"></script></section></template>`,
      "styles/a.css": `@import "shared.css"; :root { --color: red } @font-face { font-family: Demo; src: url("../fonts/demo.woff2") } .hero { color: var(--color); background: url('../media/bg.png'); content: "url('../media/not-real.png')" } /* url('../media/also-not-real.png') */`,
      "styles/shared.css": `@import url("a.css");`,
      "scripts/a.js": `import "./shared.js"; export { value } from "./exported.js"; import("./lazy.js"); const icon = new URL("../media/icon.svg", import.meta.url); import "./missing.js";`,
      "scripts/shared.js": `export const shared = true;`,
      "scripts/exported.js": `export const value = 1;`,
      "scripts/lazy.js": `export default 1;`,
      "media/poster.png": "poster",
      "media/bg.png": "background",
      "media/icon.svg": "<svg></svg>",
      "fonts/demo.woff2": "font",
    });

    const result = await new HyperframesCompositionDependencyGraph().dependenciesOf(ref, "scene-a");

    expect(result.ok ? "ok" : result.error.message).toBe("ok");
    if (!result.ok) return;
    expect(result.value.map(({ path: dependencyPath, state }) => [dependencyPath, state])).toEqual([
      ["fonts/demo.woff2", "present"],
      ["media/bg.png", "present"],
      ["media/icon.svg", "present"],
      ["media/poster.png", "present"],
      ["scripts/a.js", "present"],
      ["scripts/exported.js", "present"],
      ["scripts/lazy.js", "present"],
      ["scripts/missing.js", "missing"],
      ["scripts/shared.js", "present"],
      ["styles/a.css", "present"],
      ["styles/shared.css", "present"],
    ]);
    expect(result.value.find(({ path: dependencyPath }) => dependencyPath === "media/poster.png")?.contentHash)
      .toBe(digest("poster"));
  });

  it("refreshes a referenced missing path after exact invalidation", async () => {
    const ref = await project({
      "index.html": `<main data-composition-id="main"><div data-composition-id="scene-a" data-composition-src="scene.html"></div></main>`,
      "scene.html": `<template><section data-composition-id="scene-a"><img src="media/later.png"></section></template>`,
    });
    const graph = new HyperframesCompositionDependencyGraph();

    const missing = await graph.dependenciesOf(ref, "scene-a");
    expect(missing).toMatchObject({ ok: true, value: [{ path: "media/later.png", state: "missing", contentHash: null }] });

    await mkdir(path.join(ref.root, "media"), { recursive: true });
    await writeFile(path.join(ref.root, "media/later.png"), "later", "utf8");
    graph.invalidate(ref.id, ["media/later.png" as RelPath]);
    const present = await graph.dependenciesOf(ref, "scene-a");
    expect(present).toMatchObject({
      ok: true,
      value: [{ path: "media/later.png", state: "present", contentHash: digest("later") }],
    });
  });

  it("invalidates memoized scenes for equal or ancestor path segments only", async () => {
    const ref = await project({
      "index.html": `<main data-composition-id="main"><div data-composition-id="scene-a" data-composition-src="scene.html"></div></main>`,
      "scene.html": `<template><section data-composition-id="scene-a"><img src="media/a/poster.png"></section></template>`,
      "media/a/poster.png": "first",
    });
    const graph = new HyperframesCompositionDependencyGraph();

    const first = await graph.dependenciesOf(ref, "scene-a");
    expect(first).toMatchObject({ ok: true, value: [{ contentHash: digest("first") }] });
    await writeFile(path.join(ref.root, "media/a/poster.png"), "second", "utf8");

    graph.invalidate(ref.id, ["media/ab" as RelPath]);
    await expect(graph.dependenciesOf(ref, "scene-a")).resolves.toMatchObject({
      ok: true,
      value: [{ contentHash: digest("first") }],
    });

    graph.invalidate(ref.id, ["media/a" as RelPath]);
    await expect(graph.dependenciesOf(ref, "scene-a")).resolves.toMatchObject({
      ok: true,
      value: [{ contentHash: digest("second") }],
    });
  });

  it.each([
    ["dynamic import", `<script type="module">const name = './part.js'; import(name)</script>`],
    ["dynamic URL", `<script type="module">const name = './asset.png'; new URL(name, import.meta.url)</script>`],
    ["invalid JavaScript", `<script type="module">import {</script>`],
    ["unresolved CSS variable", `<style>.hero { background-image: var(--hero) }</style>`],
    ["invalid CSS", `<style>.hero { color: red </style>`],
  ])("fails closed for %s", async (_label, body) => {
    const ref = await project({
      "index.html": `<main data-composition-id="main"><div data-composition-id="scene-a" data-composition-src="scene.html"></div></main>`,
      "scene.html": `<template><section data-composition-id="scene-a">${body}</section></template>`,
    });

    const result = await new HyperframesCompositionDependencyGraph().dependenciesOf(ref, "scene-a");

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.DependencyGraphUnavailable } });
  });

  it("excludes remote, fragment and outside-project references", async () => {
    const ref = await project({
      "index.html": `<main data-composition-id="main"><div data-composition-id="scene-a" data-composition-src="scene.html"></div></main>`,
      "scene.html": `<template><section data-composition-id="scene-a"><img src="https://example.com/a.png"><a href="#local">x</a><img src="../outside.png"></section></template>`,
    });

    await expect(new HyperframesCompositionDependencyGraph().dependenciesOf(ref, "scene-a"))
      .resolves.toEqual({ ok: true, value: [] });
  });
});
