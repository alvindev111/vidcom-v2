// @vitest-environment node

import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FsAssetStaging } from "@vidcom/adapter";
import type { ProjectId, RelPath } from "@vidcom/contracts";
import { AssetStagingLimitError, type AbsolutePath, type ProjectRef } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; ref: ProjectRef; staging: FsAssetStaging }> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-asset-staging-"));
  roots.push(root);
  return {
    root,
    ref: {
      id: "project_asset_staging" as ProjectId,
      slug: "asset-staging",
      root: root as AbsolutePath,
      entry: "index.html" as RelPath,
    },
    staging: new FsAssetStaging(),
  };
}

describe("filesystem asset staging", () => {
  it("streams chunks into a durable hash-addressed capability and discards after finalize", async () => {
    const { ref, staging } = await fixture();
    const writer = await staging.open(ref, { filename: "../unsafe/video.mp4", maxBytes: 8 });
    await writer.write(Uint8Array.from([1, 2]));
    await writer.write(Uint8Array.from([3, 4, 5]));

    const source = await writer.finalize();
    expect(source.contentHash).toBe("sha256:74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0");
    await expect(readFile(source.sourcePath)).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
    await expect(writer.finalize()).resolves.toEqual(source);

    await writer.discard();
    await writer.discard();
    await expect(access(source.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the first chunk that would cross the exact byte limit and remains cleanable", async () => {
    const { ref, staging } = await fixture();
    const writer = await staging.open(ref, { filename: "clip.mp4", maxBytes: 3 });
    await writer.write(Uint8Array.from([1, 2]));
    await expect(writer.write(Uint8Array.from([3, 4]))).rejects.toEqual(new AssetStagingLimitError(3, 4));
    await writer.discard();
    await expect(readdir(path.join(ref.root, ".vidcom", "tmp"))).resolves.toEqual([]);
  });

  it("scavenges only expired asset-stage files", async () => {
    const { root, ref, staging } = await fixture();
    const directory = path.join(root, ".vidcom", "tmp");
    await mkdir(directory, { recursive: true });
    const expired = path.join(directory, "asset-00000000-0000-4000-8000-000000000000.tmp");
    const fresh = path.join(directory, "asset-00000000-0000-4000-8000-000000000001.tmp");
    const unrelated = path.join(directory, "render-worker.tmp");
    await Promise.all([writeFile(expired, "old"), writeFile(fresh, "new"), writeFile(unrelated, "keep")]);
    await utimes(expired, new Date(0), new Date(0));

    await expect(staging.cleanupExpired(ref, new Date(1))).resolves.toBe(1);
    await expect(readdir(directory).then((entries) => entries.sort())).resolves.toEqual([
      path.basename(fresh),
      path.basename(unrelated),
    ].sort());
  });
});
