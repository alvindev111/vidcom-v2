import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  commitRuntimeAssetGeneration,
  recoverRuntimeAssetPublish,
} from "../../scripts/build-runtime-archives.mjs";
import { DirectoryPublishInterruption } from "../../scripts/directory-generation-publish.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function generation(directory: string, value: string): Promise<void> {
  await mkdir(path.join(directory, "runtime-archives"), { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify({ value })),
    writeFile(path.join(directory, "runtime-archives", "node.tar.gz"), value),
  ]);
}

describe("runtime asset generation publish", () => {
  it("publishes manifest and archive bytes as one recoverable generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-runtime-publish-"));
    roots.push(root);
    const output = path.join(root, "assets");
    const build = path.join(root, "assets.build-fixture");
    await generation(output, "old");
    await generation(build, "new");
    await commitRuntimeAssetGeneration(build, output);
    expect(await readFile(path.join(output, "runtime-archives", "node.tar.gz"), "utf8")).toBe("new");
    expect(JSON.parse(await readFile(path.join(output, "runtime-manifest.json"), "utf8"))).toEqual({ value: "new" });
  });

  it("recovers a kill between the two directory renames", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-runtime-recover-"));
    roots.push(root);
    const output = path.join(root, "assets");
    const build = `${output}.build-fixture`;
    await generation(output, "old");
    await generation(build, "new");
    await expect(commitRuntimeAssetGeneration(build, output, {
      onBoundary(boundary: string) {
        if (boundary === "afterPreviousRename") throw new DirectoryPublishInterruption("SIGKILL fixture");
      },
    })).rejects.toThrow(/SIGKILL fixture/u);
    await recoverRuntimeAssetPublish(output);
    expect(await readFile(path.join(output, "runtime-manifest.json"), "utf8")).toContain("old");
  });
});
