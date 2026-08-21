import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ThumbnailCacheAdapter } from "@vidcom/adapter";
import { type ProjectId } from "@vidcom/contracts";

const roots: string[] = [];
const projectA = "project_cache_a" as ProjectId;
const projectB = "project_cache_b" as ProjectId;
const key = (character: string) => character.repeat(64);
const namespace = (appDataRoot: string, projectId: ProjectId) => path.join(
  appDataRoot,
  "cache",
  "thumbnails",
  createHash("sha256").update(projectId).digest("hex"),
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appData(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-thumbnail-cache-"));
  roots.push(root);
  return root;
}

describe("ThumbnailCacheAdapter", () => {
  it("keeps identical render keys isolated by hashed project namespace and publishes without temp residue", async () => {
    const root = await appData();
    const cache = new ThumbnailCacheAdapter(root);

    await cache.put(projectA, key("a"), new Uint8Array([1, 2, 3]));
    await cache.put(projectB, key("a"), new Uint8Array([4, 5]));

    await expect(cache.get(projectA, key("a"))).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(cache.get(projectB, key("a"))).resolves.toEqual(new Uint8Array([4, 5]));
    expect(await readdir(namespace(root, projectA))).toEqual([`${key("a")}.webp`]);
    expect(await readdir(path.join(root, "cache", "thumbnails"))).not.toContain(projectA);
  });

  it("rejects every non-canonical key before filesystem access", async () => {
    const root = await appData();
    const cache = new ThumbnailCacheAdapter(root);

    await expect(cache.get(projectA, "../outside")).rejects.toThrow(/key/u);
    await expect(cache.put(projectA, key("A"), new Uint8Array([1]))).rejects.toThrow(/key/u);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("uses an image-count memory LRU and returns copies rather than shared mutable bytes", async () => {
    const root = await appData();
    const cache = new ThumbnailCacheAdapter(root, { memoryLimit: 2 });
    await cache.put(projectA, key("a"), new Uint8Array([1]));
    await cache.put(projectA, key("b"), new Uint8Array([2]));
    const touched = await cache.get(projectA, key("a"));
    touched![0] = 9;
    await cache.put(projectA, key("c"), new Uint8Array([3]));
    await rm(namespace(root, projectA), { recursive: true, force: true });
    await mkdir(namespace(root, projectA), { recursive: true });

    await expect(cache.get(projectA, key("a"))).resolves.toEqual(new Uint8Array([1]));
    await expect(cache.get(projectA, key("b"))).resolves.toBeNull();
    await expect(cache.get(projectA, key("c"))).resolves.toEqual(new Uint8Array([3]));
  });

  it("enforces one disk byte budget across every project namespace", async () => {
    const root = await appData();
    let tick = 0;
    const cache = new ThumbnailCacheAdapter(root, {
      diskBudgetBytes: 6,
      clock: () => new Date(1_000 + tick++ * 1_000),
    });
    await cache.put(projectA, key("a"), new Uint8Array([1, 1, 1, 1]));
    await cache.put(projectB, key("b"), new Uint8Array([2, 2, 2, 2]));

    await expect(cache.get(projectA, key("a"))).resolves.toBeNull();
    await expect(cache.get(projectB, key("b"))).resolves.toEqual(new Uint8Array([2, 2, 2, 2]));
  });
});
