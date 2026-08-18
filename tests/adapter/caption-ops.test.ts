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
    expect(document.querySelector(".caption")?.textContent).toBe("Xin chào.");
    expect(await readFile(path.join(root, "scene.html"), "utf8")).toBe(source);
  });
});
