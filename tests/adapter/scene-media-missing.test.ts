// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";
import { CompositionHf } from "@vidcom/adapter";
import type { AbsolutePath, ProjectRef } from "@vidcom/core";

let root: string;
let ref: ProjectRef;

const entry = `<!doctype html><html><body>
<main data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="8">
  <div id="scene-1" data-composition-id="scene-1" data-start="0" data-duration="4">
    <video class="clip" src="assets/kept.mp4" data-start="0" data-duration="4"></video>
    <img class="clip" src="assets/gone.png" data-start="0" data-duration="4" />
    <img class="clip" src="https://example.com/remote.png" data-start="0" data-duration="4" />
  </div>
</main></body></html>`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-media-missing-"));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "hyperframes.json"), "{}\n");
  await writeFile(path.join(root, "vidcom.json"), '{"id":"project_missing"}\n');
  await writeFile(path.join(root, "index.html"), entry);
  await writeFile(path.join(root, "assets/kept.mp4"), "video-bytes");
  ref = {
    id: "project_missing" as ProjectId,
    slug: "project-missing",
    root: root as AbsolutePath,
    entry: "index.html" as RelPath,
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scene media", () => {
  it("says which clip sources are no longer on disk", async () => {
    const model = await new CompositionHf().parseProject(ref);
    const media = model.scenes[0]!.media;
    expect(media.map((item) => ({ src: item.src, missing: item.missing }))).toEqual([
      { src: "assets/kept.mp4", missing: false },
      { src: "assets/gone.png", missing: true },
      // A remote source is not this project's file to find, so it is never
      // reported as missing.
      { src: "https://example.com/remote.png", missing: false },
    ]);
  });

  it("resolves plain asset paths from the project root inside a sub-composition", async () => {
    const nested = `<!doctype html><html><body>
      <section data-composition-id="scene-1">
        <img class="clip" src="assets/kept.png" data-start="0" data-duration="4" />
      </section>
    </body></html>`;
    await mkdir(path.join(root, "compositions"), { recursive: true });
    await writeFile(path.join(root, "assets/kept.png"), "image-bytes");
    await writeFile(path.join(root, "compositions/scene-1.html"), nested);
    await writeFile(path.join(root, "index.html"), `<!doctype html><html><body>
      <main data-composition-id="root" data-width="1920" data-height="1080" data-duration="4">
        <div data-composition-id="scene-1" data-composition-src="compositions/scene-1.html"
          data-start="0" data-duration="4"></div>
      </main>
    </body></html>`);

    const model = await new CompositionHf().parseProject(ref);

    expect(model.scenes[0]!.media).toContainEqual(expect.objectContaining({
      src: "assets/kept.png",
      missing: false,
      url: "/api/v1/projects/project_missing/assets/assets/kept.png",
    }));
    expect(model.references).toContainEqual({
      owner: "compositions/scene-1.html",
      path: "assets/kept.png",
    });
  });
});
