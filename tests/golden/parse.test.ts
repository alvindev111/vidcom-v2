import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";
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
