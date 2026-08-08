import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildFrontendPack,
  describeAsset,
  exportedFiles,
} from "../../scripts/build-frontend-pack.mjs";
import { afterEach, describe, expect, it } from "vitest";

interface ManifestEntry {
  path: string;
  offset: number;
  length: number;
  sha256: string;
  mime: string;
  cachePolicy: "no-store" | "immutable";
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratchExport(files: Record<string, string>): Promise<{
  exportDirectory: string;
  packPath: string;
  manifestPath: string;
}> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-pack-")));
  roots.push(root);
  const exportDirectory = path.join(root, "out");
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(exportDirectory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return {
    exportDirectory,
    packPath: path.join(root, "dist", "frontend.pack"),
    manifestPath: path.join(root, "dist", "frontend-manifest.json"),
  };
}

describe("frontend pack", () => {
  it("packs raw bytes and reads every asset back at its offset", async () => {
    const files = {
      "index.html": "<!doctype html><title>home</title>",
      "_next/static/chunk.js": "console.log(1);",
      "projects/__shell.html": "<!doctype html><title>shell</title>",
    };
    const { exportDirectory, packPath, manifestPath } = await scratchExport(files);
    await buildFrontendPack(exportDirectory, packPath, manifestPath);

    const pack = await readFile(packPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: ManifestEntry[] };

    // Raw bytes, not base64: the host reads this straight out of the executable
    // as an immutable view, so a slice at the recorded offset has to be exactly
    // the file the export wrote.
    for (const entry of manifest.entries) {
      const slice = pack.subarray(entry.offset, entry.offset + entry.length);
      expect(slice.toString("utf8"), entry.path).toBe(files[entry.path as keyof typeof files]);
      expect(createHash("sha256").update(slice).digest("hex"), entry.path).toBe(entry.sha256);
    }
    expect(manifest.entries).toHaveLength(3);
  });

  it("leaves no gap or overlap between entries", async () => {
    const { exportDirectory, packPath, manifestPath } = await scratchExport({
      "a.html": "a",
      "b/c.css": "bc",
      "d.json": "ddd",
    });
    await buildFrontendPack(exportDirectory, packPath, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: ManifestEntry[] };

    // An overlap serves one asset's tail as another's head, and a gap wastes
    // space inside the executable without anyone noticing.
    let expected = 0;
    for (const entry of manifest.entries) {
      expect(entry.offset, entry.path).toBe(expected);
      expected += entry.length;
    }
    expect((await readFile(packPath)).length).toBe(expected);
  });

  it("takes the cache policy from the resolver that serves the request", async () => {
    // Deciding it twice is how the build and the host end up disagreeing, and
    // the disagreement that matters caches something forever under a rule the
    // host never applied.
    expect(describeAsset("_next/static/chunk.js", Buffer.alloc(0), 0).cachePolicy).toBe("immutable");
    expect(describeAsset("index.html", Buffer.alloc(0), 0).cachePolicy).toBe("no-store");
    expect(describeAsset("projects/__shell.txt", Buffer.alloc(0), 0).cachePolicy).toBe("no-store");
  });

  it("labels an unplanned extension as a download rather than guessing", async () => {
    // The pack only ever holds what the export wrote, so an extension outside
    // the closed table means the build produced something nobody planned for.
    expect(describeAsset("weird.bin", Buffer.alloc(0), 0).mime).toBe("application/octet-stream");
  });

  it("orders assets the same way on every build", async () => {
    const { exportDirectory, packPath, manifestPath } = await scratchExport({
      "z.html": "z",
      "a.html": "a",
      "m/n.html": "mn",
    });
    // Two builds of one export have to produce the same bytes, or the artifact
    // hash moves for reasons nobody changed.
    expect(await exportedFiles(exportDirectory)).toEqual(["a.html", "m/n.html", "z.html"]);
    const first = await buildFrontendPack(exportDirectory, packPath, manifestPath);
    const firstPack = await readFile(packPath);
    const second = await buildFrontendPack(exportDirectory, packPath, manifestPath);
    expect(second).toEqual(first);
    expect(await readFile(packPath)).toEqual(firstPack);
  });

  it("says what to run first when there is no export", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-pack-")));
    roots.push(root);
    await expect(buildFrontendPack(
      path.join(root, "out"),
      path.join(root, "frontend.pack"),
      path.join(root, "frontend-manifest.json"),
    )).rejects.toThrow(/has not been built yet/u);
  });

  it("refuses an empty export instead of packing nothing", async () => {
    // An empty pack is an artifact that starts, serves 404 for every page, and
    // looks like a routing bug.
    const { exportDirectory, packPath, manifestPath } = await scratchExport({});
    await mkdir(exportDirectory, { recursive: true });
    await expect(buildFrontendPack(exportDirectory, packPath, manifestPath))
      .rejects.toThrow(/is empty/u);
  });
});
