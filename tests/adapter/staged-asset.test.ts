import { createHash } from "node:crypto";
import {
  copyFile as fsCopyFile,
  link as fsLink,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppDataAssetStager } from "@vidcom/adapter";
import type { ContentHash, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, ResolvedPath } from "@vidcom/core";

let root: string;
let appDataRoot: string;
let targetRoot: string;

const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-staged-asset-"));
  appDataRoot = path.join(root, "app-data");
  targetRoot = path.join(root, "project", "assets");
  await mkdir(targetRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AppDataAssetStager guarded file publish", () => {
  it("rejects symlink and non-regular staged sources", async () => {
    const stager = new AppDataAssetStager(appDataRoot);
    const regular = path.join(root, "regular.bin");
    const linked = path.join(root, "linked.bin") as AbsolutePath;
    const directory = path.join(root, "directory-source") as AbsolutePath;
    await writeFile(regular, "payload");
    await symlink(regular, linked);
    await mkdir(directory);

    await expect(stager.stageFile(
      path.join(targetRoot, "linked.bin") as ResolvedPath,
      "assets/linked.bin" as RelPath,
      linked,
      hash("payload"),
    )).rejects.toBeDefined();
    await expect(stager.stageFile(
      path.join(targetRoot, "directory.bin") as ResolvedPath,
      "assets/directory.bin" as RelPath,
      directory,
      hash("payload"),
    )).rejects.toBeDefined();
  });

  it("rejects a source whose filesystem identity changes during copy", async () => {
    const sourcePath = path.join(root, "changing.bin") as AbsolutePath;
    const original = new Uint8Array(128 * 1024).fill(1);
    const changed = new Uint8Array(original.byteLength).fill(2);
    await writeFile(sourcePath, original);
    const stager = new AppDataAssetStager(appDataRoot, {
      async copySource(source: FileHandle, destination: FileHandle) {
        await destination.writeFile(await source.readFile());
        await writeFile(sourcePath, changed);
      },
      link: fsLink,
      copyFile: fsCopyFile,
    });

    await expect(stager.stageFile(
      path.join(targetRoot, "changing.bin") as ResolvedPath,
      "assets/changing.bin" as RelPath,
      sourcePath,
      hash(original),
    )).rejects.toThrow("changed during copy");
  });

  it("publishes through EXDEV without overwrite and cleanup removes only its own target", async () => {
    const sourcePath = path.join(root, "source.bin") as AbsolutePath;
    const target = path.join(targetRoot, "uploaded.bin") as ResolvedPath;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writeFile(sourcePath, bytes);
    let links = 0;
    const stager = new AppDataAssetStager(appDataRoot, {
      async copySource(source: FileHandle, destination: FileHandle) {
        await destination.writeFile(await source.readFile());
      },
      async link(source, destination) {
        links += 1;
        if (links === 1) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        await fsLink(source, destination);
      },
      copyFile: fsCopyFile,
    });
    const staged = await stager.stageFile(target, "assets/uploaded.bin" as RelPath, sourcePath, hash(bytes));

    await staged.commit();
    expect(links).toBe(2);
    expect(await readFile(target)).toEqual(Buffer.from(bytes));
    await staged.cleanup();
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an external target that wins the EXDEV fallback race", async () => {
    const sourcePath = path.join(root, "race-source.bin") as AbsolutePath;
    const target = path.join(targetRoot, "race.bin") as ResolvedPath;
    const bytes = new Uint8Array([5, 6, 7, 8]);
    await writeFile(sourcePath, bytes);
    let links = 0;
    const stager = new AppDataAssetStager(appDataRoot, {
      async copySource(source: FileHandle, destination: FileHandle) {
        await destination.writeFile(await source.readFile());
      },
      async link(source, destination) {
        links += 1;
        if (links === 1) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        await fsLink(source, destination);
      },
      async copyFile(source, destination, mode) {
        await fsCopyFile(source, destination, mode);
        await writeFile(target, "external");
      },
    });
    const staged = await stager.stageFile(target, "assets/race.bin" as RelPath, sourcePath, hash(bytes));

    await expect(staged.commit()).rejects.toMatchObject({ code: "EEXIST" });
    await staged.cleanup();
    expect(await readFile(target, "utf8")).toBe("external");
  });

  it("streams a 250 MiB staged publish and cleanup below the P5 RSS gate", async () => {
    const sourcePath = path.join(root, "large-source.bin") as AbsolutePath;
    const target = path.join(targetRoot, "large.bin") as ResolvedPath;
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const digest = createHash("sha256");
    const source = await open(sourcePath, "wx", 0o600);
    try {
      for (let index = 0; index < 250; index += 1) {
        await source.write(chunk);
        digest.update(chunk);
      }
      await source.sync();
    } finally {
      await source.close();
    }
    const contentHash = `sha256:${digest.digest("hex")}` as ContentHash;
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
    try {
      const staged = await new AppDataAssetStager(appDataRoot).stageFile(
        target,
        "assets/large.bin" as RelPath,
        sourcePath,
        contentHash,
      );
      await staged.commit();
      expect((await stat(target)).size).toBe(250 * 1024 * 1024);
      await staged.cleanup();
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearInterval(sampler);
    }
    expect(peakRss - baselineRss).toBeLessThan(64 * 1024 * 1024);
  }, 30_000);
});
