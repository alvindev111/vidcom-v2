import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { FsRenderProjectAdapter } from "@vidcom/adapter";
import type { AbsolutePath, ProjectRef } from "@vidcom/core";
import type { ProjectId, RelPath } from "@vidcom/contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FsRenderProjectAdapter", () => {
  it("stages a real guarded clone without operational roots or followed symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-render-project-"));
    roots.push(root);
    const source = path.join(root, "source");
    const renderRoot = path.join(root, "render-root");
    await Promise.all([
      mkdir(path.join(source, ".vidcom"), { recursive: true }),
      mkdir(path.join(source, "renders"), { recursive: true }),
      mkdir(path.join(source, "snapshots"), { recursive: true }),
      mkdir(renderRoot),
    ]);
    await Promise.all([
      writeFile(path.join(source, "index.html"), "old"),
      writeFile(path.join(source, "keep.txt"), "keep"),
      writeFile(path.join(source, ".vidcom", "state.json"), "{}"),
      writeFile(path.join(source, "renders", "old.mp4"), "old"),
      writeFile(path.join(source, "snapshots", "old.png"), "old"),
    ]);
    if (process.platform !== "win32") {
      await symlink(path.join(source, "keep.txt"), path.join(source, "linked.txt"));
    }
    const ref: ProjectRef = {
      id: "project_render_stage" as ProjectId,
      slug: "render-stage",
      root: source as AbsolutePath,
      entry: "index.html" as RelPath,
    };

    const staged = await new FsRenderProjectAdapter().stage(
      ref,
      renderRoot as AbsolutePath,
      "<html>guarded</html>",
      "globalThis.__VIDCOM_RUNTIME__ = true;",
    );

    await expect(readFile(path.join(staged.projectRoot, "index.html"), "utf8"))
      .resolves.toBe("<html>guarded</html>");
    await expect(readFile(path.join(staged.projectRoot, "keep.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(path.join(staged.projectRoot, ".vidcom-runtime.js"), "utf8"))
      .resolves.toContain("__VIDCOM_RUNTIME__");
    for (const excluded of [".vidcom", "renders", "snapshots", "linked.txt"]) {
      await expect(access(path.join(staged.projectRoot, excluded))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(staged.outputPath).toBe(path.join(await realpath(renderRoot), "output.mp4"));
  });

  it("reads only ordered regular PNG files and composes a deterministic contact sheet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-snapshot-artifacts-"));
    roots.push(root);
    const red = await sharp({
      create: { width: 2, height: 1, channels: 4, background: "#ff0000" },
    }).png().toBuffer();
    const blue = await sharp({
      create: { width: 1, height: 2, channels: 4, background: "#0000ff" },
    }).png().toBuffer();
    await Promise.all([
      writeFile(path.join(root, "frame-02-at-2s.PNG"), blue),
      writeFile(path.join(root, "frame-01-at-1s.png"), red),
      writeFile(path.join(root, "contact-sheet.jpg"), red),
      mkdir(path.join(root, "fake.png")),
    ]);

    const adapter = new FsRenderProjectAdapter();
    const artifacts = await adapter.readSnapshotArtifacts(root as AbsolutePath);
    expect(artifacts.map(({ name }) => name)).toEqual([
      "frame-01-at-1s.png",
      "frame-02-at-2s.PNG",
    ]);
    const first = await adapter.composeContactSheet(artifacts.map(({ content }) => content));
    const second = await adapter.composeContactSheet(artifacts.map(({ content }) => content));
    expect(first).toEqual(second);
    await expect(sharp(first).metadata()).resolves.toMatchObject({
      format: "png",
      width: 640,
      height: 180,
    });
  });
});
