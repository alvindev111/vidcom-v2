import { copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { checkPathSyntax, type AbsolutePath, type ProjectRef, type RenderProjectPort, type ResolvedPath } from "@vidcom/core";

import { writeAtomic } from "./atomic-write";
import { syncDirectory } from "./durability";

const EXCLUDED_ROOTS = new Set([".vidcom", "renders", "snapshots"]);

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function copyRegularTree(source: string, target: string, rootLevel = false): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (rootLevel && EXCLUDED_ROOTS.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyRegularTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
  await syncDirectory(target);
}

/** Creates a disposable project clone without following user-controlled symlinks. */
export class FsRenderProjectAdapter implements RenderProjectPort {
  async stage(
    ref: ProjectRef,
    renderRoot: AbsolutePath,
    document: string,
    runtimeSource: string,
  ): Promise<{ projectRoot: AbsolutePath; outputPath: AbsolutePath; snapshotOutputRoot: AbsolutePath }> {
    if (checkPathSyntax(ref.entry)) throw new TypeError("render project entry path is invalid");
    const [sourceRoot, ownedRoot] = await Promise.all([realpath(ref.root), realpath(renderRoot)]);
    const projectRoot = path.join(ownedRoot, "project");
    await copyRegularTree(sourceRoot, projectRoot, true);
    const entry = path.resolve(projectRoot, ref.entry);
    if (!contained(projectRoot, entry)) throw new TypeError("render project entry escapes its clone");
    const entryParent = path.dirname(entry);
    const parentStat = await lstat(entryParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("render project entry parent is not a regular directory");
    await writeAtomic(entry as ResolvedPath, document);
    await writeAtomic(path.join(projectRoot, ".vidcom-runtime.js") as ResolvedPath, runtimeSource);
    const snapshotOutputRoot = path.join(ownedRoot, "snapshot-output");
    await mkdir(snapshotOutputRoot, { recursive: false, mode: 0o700 });
    await syncDirectory(projectRoot);
    return {
      projectRoot: projectRoot as AbsolutePath,
      outputPath: path.join(ownedRoot, "output.mp4") as AbsolutePath,
      snapshotOutputRoot: snapshotOutputRoot as AbsolutePath,
    };
  }

  async readArtifact(outputPath: AbsolutePath): Promise<Uint8Array> {
    return new Uint8Array(await readFile(outputPath));
  }

  async readSnapshotArtifacts(outputRoot: AbsolutePath): Promise<Array<{ name: string; content: Uint8Array }>> {
    const root = await realpath(outputRoot);
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .sort((left, right) => left.name.localeCompare(right.name));
    return Promise.all(entries.map(async (entry) => ({
      name: entry.name,
      content: new Uint8Array(await readFile(path.join(root, entry.name))),
    })));
  }

  async composeContactSheet(images: readonly Uint8Array[]): Promise<Uint8Array> {
    if (images.length === 0) throw new TypeError("contact sheet requires at least one image");
    const width = 320;
    const height = 180;
    const columns = Math.min(4, images.length);
    const rows = Math.ceil(images.length / columns);
    const tiles = await Promise.all(images.map(async (image, index) => ({
      input: await sharp(image).resize(width, height, {
        fit: "contain",
        background: { r: 15, g: 23, b: 42, alpha: 1 },
      }).png().toBuffer(),
      left: (index % columns) * width,
      top: Math.floor(index / columns) * height,
    })));
    return new Uint8Array(await sharp({
      create: {
        width: columns * width,
        height: rows * height,
        channels: 4,
        background: { r: 15, g: 23, b: 42, alpha: 1 },
      },
    }).composite(tiles).png().toBuffer());
  }
}
