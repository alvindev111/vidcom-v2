// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";

import { applyCompositionOps } from "@vidcom/adapter";
import { type ProjectId, type RelPath } from "@vidcom/contracts";
import { type AbsolutePath, type ProjectRef } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("caption composition operations", () => {
  it("replaces every old captions block under the target without writing the source file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-caption-op-"));
    roots.push(root);
    const source = `<!doctype html><html><body>
      <main data-composition-id="scene-1" data-duration="5">
        <div class="captions"><p>old one</p></div>
        <section><div class="captions"><p>old two</p></div></section>
      </main>
    </body></html>`;
    await writeFile(path.join(root, "scene.html"), source);
    const ref: ProjectRef = {
      id: "project_caption_op" as ProjectId,
      slug: "caption-op",
      root: root as AbsolutePath,
      entry: "scene.html" as RelPath,
    };

    const result = await applyCompositionOps(ref, "scene.html" as RelPath, [{
      kind: "replaceCaptions",
      target: "scene-1",
      value: {
        timingSource: "engine",
        cues: [{
          start: 0.25,
          end: 1.45,
          text: "Xin chào.",
          words: [
            { text: "Xin", start: 0.25, end: 0.6 },
            { text: "chào.", start: 0.6, end: 1.1 },
          ],
        }],
      },
    }]);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const { document } = parseHTML(result.value);
    expect(document.querySelectorAll('[data-composition-id="scene-1"] .captions')).toHaveLength(1);
    expect(document.querySelector(".captions")?.getAttribute("data-caption-timing")).toBe("engine");
    expect(document.querySelector(".captions")?.getAttribute("data-hf-id")).toBe("captions-scene-1");
    expect(document.querySelector(".captions")?.classList.contains("clip")).toBe(true);
    const paragraph = document.querySelector(".caption");
    expect(paragraph?.classList.contains("clip")).toBe(true);
    expect(paragraph?.getAttribute("data-start")).toBe("0.25");
    expect(paragraph?.getAttribute("data-duration")).toBe("1.2");
    expect(paragraph?.textContent).toBe("Xin chào.");
    expect([...document.querySelectorAll(".caption .w")].map((span) => ({
      text: span.textContent,
      start: span.getAttribute("data-start"),
      end: span.getAttribute("data-end"),
    }))).toEqual([
      { text: "Xin", start: "0.25", end: "0.6" },
      { text: "chào.", start: "0.6", end: "1.1" },
    ]);
    expect([...paragraph!.childNodes].map((node) => node.textContent)).toEqual(["Xin", " ", "chào."]);

    const estimated = await applyCompositionOps(ref, "scene.html" as RelPath, [{
      kind: "replaceCaptions",
      target: "scene-1",
      value: {
        timingSource: "estimated",
        cues: [{ start: 2, end: 3.2, text: "Ước lượng", words: [{ text: "Ước", start: 2, end: 2.4 }, { text: "lượng", start: 2.4, end: 3 }] }],
      },
    }]);
    expect(estimated).toMatchObject({ ok: true });
    if (estimated.ok) {
      expect(parseHTML(estimated.value).document.querySelector(".captions")?.getAttribute("data-caption-timing"))
        .toBe("estimated");
    }
    expect(await readFile(path.join(root, "scene.html"), "utf8")).toBe(source);
  });

  it("round-trips hostile caption text without creating executable markup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-caption-hostile-"));
    roots.push(root);
    const source = '<html><body><main data-composition-id="scene-1" data-duration="5"></main></body></html>';
    await writeFile(path.join(root, "scene.html"), source);
    const ref: ProjectRef = {
      id: "project_caption_hostile" as ProjectId,
      slug: "caption-hostile",
      root: root as AbsolutePath,
      entry: "scene.html" as RelPath,
    };
    const tokens = [
      "</span><script>globalThis.__captionPwned=1</script>",
      "&amp;",
      "\u202eRTL\u2066",
      "control\u0007cue",
    ];
    const text = tokens.join(" ");
    const words = tokens.map((token, index) => ({ text: token, start: index, end: index + 0.5 }));

    const result = await applyCompositionOps(ref, "scene.html" as RelPath, [{
      kind: "replaceCaptions",
      target: "scene-1",
      value: { timingSource: "engine", cues: [{ start: 0, end: 4, text, words }] },
    }]);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const { document } = parseHTML(result.value);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelector(".caption")?.textContent).toBe(text);
    expect([...document.querySelectorAll(".caption .w")].map((span) => span.textContent)).toEqual(tokens);
    expect(document.querySelector("[onerror], [onclick], [src]")).toBeNull();
    expect(await readFile(path.join(root, "scene.html"), "utf8")).toBe(source);
  });

  it.each([
    [Number.NaN, 1],
    [0, Number.POSITIVE_INFINITY],
    [0, 1, Number.NEGATIVE_INFINITY, 0.5],
    [0, 1, 0, Number.NaN],
  ])("rejects non-finite cue/word timing before serialization", async (
    cueStart,
    cueEnd,
    wordStart = 0,
    wordEnd = 0.5,
  ) => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-caption-nonfinite-"));
    roots.push(root);
    const source = '<html><body><main data-composition-id="scene-1"></main></body></html>';
    await writeFile(path.join(root, "scene.html"), source);
    const ref: ProjectRef = {
      id: "project_caption_nonfinite" as ProjectId,
      slug: "caption-nonfinite",
      root: root as AbsolutePath,
      entry: "scene.html" as RelPath,
    };

    await expect(applyCompositionOps(ref, "scene.html" as RelPath, [{
      kind: "replaceCaptions",
      target: "scene-1",
      value: {
        timingSource: "engine",
        cues: [{
          start: cueStart,
          end: cueEnd,
          text: "word",
          words: [{ text: "word", start: wordStart, end: wordEnd }],
        }],
      },
    }])).resolves.toMatchObject({ ok: false, error: { code: "sdk_rejected" } });
    expect(await readFile(path.join(root, "scene.html"), "utf8")).toBe(source);
  });
});
