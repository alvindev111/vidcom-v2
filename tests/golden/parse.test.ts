import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";
import { CompositionHf, type RootTrack, type Scene } from "@vidcom/adapter";
import type { AbsolutePath } from "@vidcom/core";

const FIXTURE_ROOT = path.resolve(import.meta.dirname, "../../fixtures/parse");

/** Read a minimal parse fixture committed as the source side of a golden pair. */
async function parseFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-parse-${name}-`));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "hyperframes.json"), "{}\n");
    await writeFile(path.join(root, "vidcom.json"), JSON.stringify({ id: name }));
    await writeFile(path.join(root, "index.html"), await readFile(path.join(FIXTURE_ROOT, `${name}.html`), "utf8"));
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
