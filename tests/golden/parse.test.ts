import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SceneSchema, type ProjectId, type RelPath } from "@vidcom/contracts";
import { CompositionHf, type RootTrack, type Scene } from "@vidcom/adapter";
import type { AbsolutePath } from "@vidcom/core";

const FIXTURE_ROOT = path.resolve(import.meta.dirname, "../../fixtures/parse");

/** Read a minimal parse fixture committed as the source side of a golden pair. */
async function parseFixture(name: string, prepare?: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-parse-${name}-`));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "hyperframes.json"), "{}\n");
    await writeFile(path.join(root, "vidcom.json"), JSON.stringify({ id: name }));
    await writeFile(path.join(root, "index.html"), await readFile(path.join(FIXTURE_ROOT, `${name}.html`), "utf8"));
    await prepare?.(root);
    return await new CompositionHf().parseProject({
      id: name as ProjectId,
      slug: name,
      root: root as AbsolutePath,
      entry: "index.html" as RelPath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function hosts(name: string) {
  return ((await parseFixture(name)).scenes as Scene[]).map(({ id, src, start, duration, trackIndex }) => ({
    id, src, start, duration, trackIndex,
  }));
}

async function elements(name: string) {
  const track = (await parseFixture(name)).rootTrack as RootTrack | null;
  return track
    ? { elements: track.elements, unresolvedEffects: track.unresolvedEffects }
    : { elements: [], unresolvedEffects: 0 };
}

/** Serialize parse output as valid JSON so the expected artifact is reusable. */
function golden(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("composition parse structure", () => {
  it("reports the entry digest and byte size from the bytes already parsed", async () => {
    const raw = await readFile(path.join(FIXTURE_ROOT, "inline-scene.html"), "utf8");
    await expect(parseFixture("inline-scene")).resolves.toMatchObject({
      sources: [{
        path: "index.html",
        contentHash: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
        byteSize: new TextEncoder().encode(raw).byteLength,
      }],
    });
  });

  it("normalizes a legacy narration without stale metadata as current", async () => {
    const model = await parseFixture("inline-scene", async (root) => {
      await mkdir(path.join(root, "narration"));
      await writeFile(path.join(root, "narration/inline.json"), JSON.stringify({
        sceneId: "inline",
        text: "Legacy",
        voice: "af_heart",
        status: "mock",
        audioPath: "narration/inline.wav",
        command: "tts",
        revision: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
      }));
    });
    expect((model.scenes as Scene[])[0]?.narration).toMatchObject({ staleSince: null, status: "mock" });
  });

  it("reports referenced sources once in deterministic first-reference order", async () => {
    const entry = await readFile(path.join(FIXTURE_ROOT, "source-order.html"), "utf8");
    const sourceA = "<div data-composition-id=\"a\">A</div>\n";
    const sourceB = "<div data-composition-id=\"b\">B</div>\n";
    const model = await parseFixture("source-order", async (root) => {
      await mkdir(path.join(root, "compositions"));
      await writeFile(path.join(root, "compositions/a.html"), sourceA);
      await writeFile(path.join(root, "compositions/b.html"), sourceB);
    });
    expect(model.sources.map((source) => source.path)).toEqual([
      "index.html",
      "compositions/b.html",
      "compositions/a.html",
    ]);
    expect(model.sources).toHaveLength(3);
    expect(model.sources.map(({ contentHash, byteSize }) => ({ contentHash, byteSize }))).toEqual(
      [entry, sourceB, sourceA].map((content) => ({
        contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        byteSize: new TextEncoder().encode(content).byteLength,
      })),
    );
  });

  it("canonicalizes nested and root-track references while excluding external URLs", async () => {
    const model = await parseFixture("project-references", async (root) => {
      await mkdir(path.join(root, "compositions"));
      await writeFile(path.join(root, "compositions/nested.html"), `
        <section data-composition-id="nested">
          <img src="../assets/logo.svg" />
          <img src="logo.svg" />
          <img src="https://example.com/external.svg" />
          <img src="data:image/svg+xml;base64,AA==" />
          <img src="../../outside.svg" />
        </section>
      `);
    });
    expect(model.references).toEqual([
      { owner: "index.html", path: "compositions/nested.html" },
      { owner: "compositions/nested.html", path: "assets/logo.svg" },
      { owner: "compositions/nested.html", path: "compositions/logo.svg" },
      { owner: "index.html", path: "assets/root.svg" },
    ]);
  });

  it("reads children from a template wrapper", async () => {
    await expect(golden(await elements("template-wrap"))).toMatchFileSnapshot(
      "../../fixtures/parse/template-wrap-expected.json",
    );
  });

  it("keeps an inline composition host in the scene list", async () => {
    await expect(golden(await hosts("inline-scene"))).toMatchFileSnapshot(
      "../../fixtures/parse/inline-scene-expected.json",
    );
  });

  it("projects scene ownership, role, authored element identity, and owned layout offsets", async () => {
    const model = await parseFixture("inline-scene", async (root) => {
      await mkdir(path.join(root, "compositions"));
      await writeFile(path.join(root, "hyperframes.json"), '{"vidcomAgentKitVersion":9}\n');
      await writeFile(path.join(root, "index.html"), `
        <main data-composition-id="main" data-width="1920" data-height="1080" data-duration="8">
          <section data-composition-id="inline" data-scene-role="utility" data-story-pattern="question-reveal"
            data-seam-kind="contrast" data-seam-token="blue-orbit" data-start="0" data-duration="4">
            <h2 data-hf-id="inline-title" data-duration="1">Inline</h2>
          </section>
          <section data-composition-id="mounted" data-composition-src="compositions/mounted.html"
            data-start="4" data-duration="4"></section>
        </main>
      `);
      await writeFile(path.join(root, "compositions/mounted.html"), `
        <section data-composition-id="mounted" data-scene-role="story"
          data-story-pattern="state-transformation" data-seam-kind="transform" data-seam-token="red-thread"
          data-width="1920" data-height="1080" data-duration="4">
          <div data-hf-id="movable" data-vidcom-layout-offset
            style="--vidcom-layout-x: 12px; --vidcom-layout-y: -4px" data-duration="1">Move</div>
          <div data-duration="1">Structural target</div>
          <div data-hf-id="authored-translate" style="translate: 5px 0" data-duration="1">Locked</div>
        </section>
      `);
    });

    const inline = (model.scenes as Scene[]).find((scene) => scene.id === "inline");
    const mounted = (model.scenes as Scene[]).find((scene) => scene.id === "mounted");
    expect(model.agentKitVersion).toBe(9);
    expect(inline).toMatchObject({
      src: null,
      sourceFile: "index.html",
      role: "utility",
      storyPattern: "question-reveal",
      seam: { kind: "contrast", token: "blue-orbit" },
    });
    expect(mounted).toMatchObject({
      src: "compositions/mounted.html",
      sourceFile: "compositions/mounted.html",
      role: "story",
      storyPattern: "state-transformation",
      seam: { kind: "transform", token: "red-thread" },
      elements: expect.arrayContaining([
        expect.objectContaining({
          authoredId: "movable",
          layoutOffset: { x: 12, y: -4 },
          positionEditable: true,
        }),
        expect.objectContaining({ authoredId: null, layoutOffset: null, positionEditable: false }),
        expect.objectContaining({
          authoredId: "authored-translate",
          layoutOffset: null,
          positionEditable: false,
        }),
      ]),
    });
    expect(SceneSchema.safeParse(inline).success).toBe(true);
    expect(SceneSchema.safeParse(mounted).success).toBe(true);
  });

  it("attributes statically resolved root choreography to inline scenes even when rows are hidden", async () => {
    const model = await parseFixture("inline-scene", async (root) => {
      await writeFile(path.join(root, "index.html"), `
        <main data-composition-id="main" data-duration="18">
          <section data-composition-id="s01" data-start="0" data-duration="9" data-no-timeline>
            <div id="hero-1">One</div>
          </section>
          <section data-composition-id="s02" data-start="9" data-duration="9" data-no-timeline>
            <div id="hero-2">Two</div>
          </section>
          <script>const tl = gsap.timeline({ paused: true });
            tl.to("#hero-1", { scale: 1.1, duration: 0.5 }, 0.2);
            tl.to("#hero-1", { rotation: 8, duration: 0.5 }, 3.2);
            tl.to("#hero-1", { scale: 1.2, duration: 0.5 }, 6.2);
            tl.to("#hero-2", { scale: 1.1, duration: 0.5 }, 0.3);
            window.__timelines = window.__timelines || {}; window.__timelines.main = tl;</script>
        </main>
      `);
    });
    expect(model.scenes.find(({ id }) => id === "s01")?.elements.flatMap(({ effects }) => effects))
      .toHaveLength(3);
    expect(model.scenes.find(({ id }) => id === "s02")?.elements.flatMap(({ effects }) => effects))
      .toHaveLength(1);
    expect((model.rootTrack as RootTrack | null)?.elements ?? []).toHaveLength(0);
  });

  it("keeps authored media src while resolving query and fragment references to the local file", async () => {
    const model = await parseFixture("project-references", async (root) => {
      await mkdir(path.join(root, "compositions"));
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets/ảnh biển.png"), "png");
      await writeFile(path.join(root, "assets/poster.jpg"), "jpg");
      await writeFile(path.join(root, "assets/tile.webp"), "webp");
      await writeFile(path.join(root, "compositions/nested.html"), `
        <section data-composition-id="nested" data-width="1920" data-height="1080" data-duration="4">
          <img src="../assets/%E1%BA%A3nh%20bi%E1%BB%83n.png?v=2#focus" />
          <img src="../assets/poster.jpg#cover" />
          <img src="../assets/tile.webp?rev=4" />
        </section>
      `);
    });
    const media = (model.scenes as Scene[]).find((scene) => scene.id === "nested")?.media;
    expect(media).toEqual([
      {
        kind: "image",
        src: "../assets/%E1%BA%A3nh%20bi%E1%BB%83n.png?v=2#focus",
        url: "/api/hf/project-references/files/assets/ảnh biển.png",
        start: 0,
        duration: null,
        missing: false,
      },
      {
        kind: "image",
        src: "../assets/poster.jpg#cover",
        url: "/api/hf/project-references/files/assets/poster.jpg",
        start: 0,
        duration: null,
        missing: false,
      },
      {
        kind: "image",
        src: "../assets/tile.webp?rev=4",
        url: "/api/hf/project-references/files/assets/tile.webp",
        start: 0,
        duration: null,
        missing: false,
      },
    ]);
  });

  it("keeps external media out of project lookup and rejects absolute or escaping local paths", async () => {
    const model = await parseFixture("project-references", async (root) => {
      await mkdir(path.join(root, "compositions"));
      await writeFile(path.join(root, "compositions/nested.html"), `
        <section data-composition-id="nested" data-width="1920" data-height="1080" data-duration="4">
          <img src="https://example.com/poster.png?v=2#focus" />
          <img src="data:image/png;base64,AA==" />
          <img src="blob:https://example.com/id" />
          <img src="/absolute.png" />
          <img src="../../escape.png" />
        </section>
      `);
    });
    const media = (model.scenes as Scene[]).find((scene) => scene.id === "nested")?.media ?? [];
    expect(media.slice(0, 3).map(({ url, missing }) => ({ url, missing }))).toEqual([
      { url: "https://example.com/poster.png?v=2#focus", missing: false },
      { url: "data:image/png;base64,AA==", missing: false },
      { url: "blob:https://example.com/id", missing: false },
    ]);
    expect(media.slice(3).map(({ url, missing }) => ({ url, missing }))).toEqual([
      { url: "/absolute.png", missing: true },
      { url: "../../escape.png", missing: true },
    ]);
  });

  it.skipIf(process.platform === "win32")("does not follow a media symlink outside the project", async () => {
    let outside = "";
    try {
      const model = await parseFixture("project-references", async (root) => {
        outside = `${root}-outside.png`;
        await writeFile(outside, "outside");
        await mkdir(path.join(root, "assets"));
        await mkdir(path.join(root, "compositions"));
        await symlink(outside, path.join(root, "assets/escape.png"));
        await writeFile(path.join(root, "compositions/nested.html"), `
          <section data-composition-id="nested" data-width="1920" data-height="1080" data-duration="4">
            <img src="../assets/escape.png" />
          </section>
        `);
      });
      expect((model.scenes as Scene[]).find((scene) => scene.id === "nested")?.media[0])
        .toMatchObject({ src: "../assets/escape.png", missing: true });
    } finally {
      if (outside) await rm(outside, { force: true });
    }
  });

  it("selects the outer root when nested hosts also declare dimensions", async () => {
    await expect(golden(await hosts("multiple-sized-hosts"))).toMatchFileSnapshot(
      "../../fixtures/parse/multiple-sized-hosts-expected.json",
    );
  });

  it("normalizes a GSAP selector scoped by composition id", async () => {
    await expect(golden(await elements("scoped-selector"))).toMatchFileSnapshot(
      "../../fixtures/parse/scoped-selector-expected.json",
    );
  });

  it("counts an unresolved tween without inventing a row or start time", async () => {
    await expect(golden(await elements("unresolved-tween"))).toMatchFileSnapshot(
      "../../fixtures/parse/unresolved-tween-expected.json",
    );
  });

  it("keeps an element represented only by a tween", async () => {
    await expect(golden(await elements("tween-only-element"))).toMatchFileSnapshot(
      "../../fixtures/parse/tween-only-element-expected.json",
    );
  });

  it("keeps timed media authored directly under body", async () => {
    await expect(golden(await elements("body-media"))).toMatchFileSnapshot(
      "../../fixtures/parse/body-media-expected.json",
    );
  });

  it("decodes legacy data-end and data-layer timing", async () => {
    await expect(golden(await hosts("legacy-timing"))).toMatchFileSnapshot(
      "../../fixtures/parse/legacy-timing-expected.json",
    );
  });

  it("scopes parser-local effect ids by script index", async () => {
    await expect(golden(await elements("two-gsap-scripts"))).toMatchFileSnapshot(
      "../../fixtures/parse/two-gsap-scripts-expected.json",
    );
  });
});
