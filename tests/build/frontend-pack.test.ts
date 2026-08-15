import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildFrontendPack,
  describeAsset,
  exportedFiles,
  recoverFrontendPublication,
  reportFrontendPackFailure,
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

  it("rejects a symlinked output parent without touching its external target", async () => {
    const { exportDirectory, packPath, manifestPath } = await scratchExport({
      "index.html": "safe export",
    });
    const outputDirectory = path.dirname(packPath);
    const external = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-pack-external-")));
    roots.push(external);
    const sentinel = path.join(external, "sentinel.txt");
    await writeFile(sentinel, "keep", "utf8");
    await symlink(external, outputDirectory, process.platform === "win32" ? "junction" : "dir");

    await expect(buildFrontendPack(exportDirectory, packPath, manifestPath))
      .rejects.toThrow(/parent chain must contain only real directories/u);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await expect(readFile(path.join(external, path.basename(packPath))))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(external, path.basename(manifestPath))))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink inside the export and preserves the published pair", async () => {
    const { exportDirectory, packPath, manifestPath } = await scratchExport({
      "index.html": "generation one",
    });
    await buildFrontendPack(exportDirectory, packPath, manifestPath);
    const previousPack = await readFile(packPath);
    const previousManifest = await readFile(manifestPath);

    const external = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-export-external-")));
    roots.push(external);
    const sentinel = path.join(external, "sentinel.txt");
    await writeFile(sentinel, "do not pack", "utf8");
    await symlink(
      external,
      path.join(exportDirectory, "external-assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(path.join(exportDirectory, "index.html"), "generation two", "utf8");

    await expect(buildFrontendPack(exportDirectory, packPath, manifestPath))
      .rejects.toThrow(/only real directories and regular files/u);
    expect(await readFile(sentinel, "utf8")).toBe("do not pack");
    expect(await readFile(packPath)).toEqual(previousPack);
    expect(await readFile(manifestPath)).toEqual(previousManifest);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO inside the export and preserves the published pair",
    async () => {
      const { exportDirectory, packPath, manifestPath } = await scratchExport({
        "index.html": "generation one",
      });
      await buildFrontendPack(exportDirectory, packPath, manifestPath);
      const previousPack = await readFile(packPath);
      const previousManifest = await readFile(manifestPath);
      await writeFile(path.join(exportDirectory, "index.html"), "generation two", "utf8");

      const fifoPath = path.join(exportDirectory, "blocking-asset");
      const fifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8", shell: false });
      expect(fifo.error).toBeUndefined();
      expect(fifo.status, fifo.stderr).toBe(0);
      await expect(buildFrontendPack(exportDirectory, packPath, manifestPath))
        .rejects.toThrow(/only real directories and regular files/u);
      expect(await readFile(packPath)).toEqual(previousPack);
      expect(await readFile(manifestPath)).toEqual(previousManifest);
    },
  );

  it("requires the pack and manifest transaction paths to be disjoint", async () => {
    const { exportDirectory, packPath } = await scratchExport({ "index.html": "safe export" });
    await expect(buildFrontendPack(exportDirectory, packPath, packPath))
      .rejects.toThrow(/paths must be disjoint/u);
  });

  it.skipIf(process.platform === "win32")(
    "recovers the prior pair after a real second-boundary permission failure",
    async () => {
      const { exportDirectory, packPath, manifestPath } = await scratchExport({
        "index.html": "generation one",
      });
      await buildFrontendPack(exportDirectory, packPath, manifestPath);
      const previousPack = await readFile(packPath);
      const previousManifest = await readFile(manifestPath);
      await writeFile(path.join(exportDirectory, "index.html"), "generation two", "utf8");

      const outputDirectory = path.dirname(packPath);
      let failure: unknown;
      try {
        await buildFrontendPack(exportDirectory, packPath, manifestPath, {
          afterPackPublished: async () => {
            // The pack boundary has committed. Removing directory write access
            // makes the manifest rename fail through the real filesystem.
            await chmod(outputDirectory, 0o500);
          },
        });
      } catch (error) {
        failure = error;
      } finally {
        await chmod(outputDirectory, 0o700);
      }

      expect(failure).toBeInstanceOf(AggregateError);
      const original = (failure as AggregateError).errors[0] as NodeJS.ErrnoException;
      expect(["EACCES", "EPERM"]).toContain(original.code);
      await recoverFrontendPublication(packPath, manifestPath);
      expect(await readFile(packPath)).toEqual(previousPack);
      expect(await readFile(manifestPath)).toEqual(previousManifest);
    },
  );

  it("recovers a killed publisher without ever accepting a mixed pair", async () => {
    const { exportDirectory, packPath, manifestPath } = await scratchExport({
      "index.html": "generation one",
    });
    await buildFrontendPack(exportDirectory, packPath, manifestPath);
    const previousPack = await readFile(packPath);
    const previousManifest = await readFile(manifestPath);
    await writeFile(path.join(exportDirectory, "index.html"), "generation two", "utf8");

    const childPath = path.join(path.dirname(exportDirectory), "crash-publisher.mjs");
    const moduleUrl = pathToFileURL(path.resolve("scripts/build-frontend-pack.mjs")).href;
    await writeFile(childPath, [
      `import { buildFrontendPack } from ${JSON.stringify(moduleUrl)};`,
      `await buildFrontendPack(${JSON.stringify(exportDirectory)},`,
      `  ${JSON.stringify(packPath)}, ${JSON.stringify(manifestPath)}, {`,
      "    afterPackPublished() { process.exit(86); },",
      "  });",
      "",
    ].join("\n"), "utf8");
    const child = spawnSync(process.execPath, [childPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(86);

    // A killed process may leave one boundary absent, but never an old
    // manifest beside a new pack. Recovery chooses the complete prior pair.
    await expect(readFile(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    await recoverFrontendPublication(packPath, manifestPath);
    expect(await readFile(packPath)).toEqual(previousPack);
    expect(await readFile(manifestPath)).toEqual(previousManifest);

    await buildFrontendPack(exportDirectory, packPath, manifestPath);
    const nextPack = await readFile(packPath);
    const nextManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: ManifestEntry[];
    };
    const index = nextManifest.entries.find((entry) => entry.path === "index.html");
    expect(index).toBeDefined();
    expect(nextPack.subarray(index!.offset, index!.offset + index!.length).toString("utf8"))
      .toBe("generation two");
  });

  it("turns an unclassified top-level filesystem rejection into a nonzero exit", () => {
    const previous = process.exitCode;
    let stderr = "";
    try {
      process.exitCode = 0;
      reportFrontendPackFailure(new Error("raw fs rejection"), {
        write(chunk: string) { stderr += chunk; return true; },
      });
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain("raw fs rejection");
    } finally {
      process.exitCode = previous;
    }
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
