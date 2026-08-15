import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  checkPathSyntax,
  type AbsolutePath,
  type ProjectDirectoryPort,
  type ResolvedPath,
  type WorkspaceOperationId,
} from "@vidcom/core";
import type { RelPath } from "@vidcom/contracts";

import { writeAtomic } from "./atomic-write";
import { syncDirectory } from "./durability";
import { readStagingMarker } from "./import-staging";

const CREATE_MARKER = ".vidcom-create-";
const QUARANTINE_MARKER = ".vidcom-quarantine-";

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i.test(slug);
}

/** Native directory lifecycle adapter restricted to direct children of one injected workspace root. */
export class FsProjectDirectoryAdapter implements ProjectDirectoryPort {
  constructor(private readonly workspaceRoot: AbsolutePath) {}

  private async root(): Promise<string> {
    return realpath(this.workspaceRoot);
  }

  private async directChild(target: AbsolutePath): Promise<{ root: string; target: string }> {
    const root = await this.root();
    const resolved = path.resolve(target);
    if (!contained(root, resolved) || path.dirname(resolved) !== root) {
      throw new Error("project directory target is not a direct workspace child");
    }
    return { root, target: resolved };
  }

  async projectRoot(workspaceRoot: AbsolutePath, slug: string): Promise<AbsolutePath> {
    if (!validSlug(slug)) throw new TypeError("project slug is invalid");
    const [injected, requested] = await Promise.all([this.root(), realpath(workspaceRoot)]);
    if (injected !== requested) throw new Error("project root differs from the injected workspace");
    return path.join(injected, slug) as AbsolutePath;
  }

  async stageCreate(
    workspaceRoot: AbsolutePath,
    slug: string,
    operationId: WorkspaceOperationId,
  ): Promise<{ stagingRoot: AbsolutePath; finalRoot: AbsolutePath }> {
    const { stagingRoot: staging, finalRoot: final } = await this.createPaths(workspaceRoot, slug, operationId);
    if (await exists(staging) || await exists(final)) throw new Error("project create target already exists");
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await syncDirectory(path.dirname(staging));
    return { stagingRoot: staging as AbsolutePath, finalRoot: final as AbsolutePath };
  }

  async createPaths(
    workspaceRoot: AbsolutePath,
    slug: string,
    operationId: WorkspaceOperationId,
  ): Promise<{ stagingRoot: AbsolutePath; finalRoot: AbsolutePath }> {
    if (!validSlug(slug)) throw new TypeError("project slug is invalid");
    const [injected, requested] = await Promise.all([this.root(), realpath(workspaceRoot)]);
    if (injected !== requested) throw new Error("project staging root differs from the injected workspace");
    return {
      stagingRoot: path.join(injected, `.${slug}${CREATE_MARKER}${operationId}`) as AbsolutePath,
      finalRoot: path.join(injected, slug) as AbsolutePath,
    };
  }

  async writeStagedFiles(
    stagingRoot: AbsolutePath,
    files: Array<{ path: RelPath; content: string | Uint8Array }>,
  ): Promise<void> {
    const { root, target: staging } = await this.directChild(stagingRoot);
    if (!path.basename(staging).includes(CREATE_MARKER) || !(await exists(staging))) {
      throw new Error("staging directory is not owned by VidCom");
    }
    const canonicalStaging = await realpath(staging);
    if (canonicalStaging !== staging) throw new Error("staging directory must not be a symlink");
    const seen = new Set<string>();
    for (const file of files) {
      if (checkPathSyntax(file.path)) throw new TypeError("staged project file path is invalid");
      const target = path.resolve(staging, file.path);
      if (!contained(staging, target) || seen.has(target)) throw new TypeError("staged project file escapes or duplicates");
      seen.add(target);
      await mkdir(path.dirname(target), { recursive: true });
      const canonicalParent = await realpath(path.dirname(target));
      if (!contained(canonicalStaging, canonicalParent)) {
        throw new Error("staged project file parent escapes through a symlink");
      }
      await writeAtomic(target as ResolvedPath, file.content);
    }
    await syncDirectory(staging);
    await syncDirectory(root);
  }

  async publishCreate(stagingRoot: AbsolutePath, finalRoot: AbsolutePath): Promise<void> {
    const staging = await this.directChild(stagingRoot);
    const final = await this.directChild(finalRoot);
    if (staging.root !== final.root || !path.basename(staging.target).includes(CREATE_MARKER)) {
      throw new Error("project create paths are not an owned pair");
    }
    if (await exists(final.target)) throw new Error("final project directory already exists");
    await rename(staging.target, final.target);
    await syncDirectory(staging.root);
  }

  async rename(from: AbsolutePath, to: AbsolutePath): Promise<void> {
    const source = await this.directChild(from);
    const target = await this.directChild(to);
    if (source.root !== target.root || await exists(target.target)) {
      throw new Error("project rename target is unavailable");
    }
    await rename(source.target, target.target);
    await syncDirectory(source.root);
  }

  async quarantine(root: AbsolutePath, operationId: WorkspaceOperationId): Promise<AbsolutePath> {
    const source = await this.directChild(root);
    const quarantine = await this.quarantinePath(root, operationId);
    if (await exists(quarantine)) throw new Error("project quarantine target already exists");
    await rename(source.target, quarantine);
    await syncDirectory(source.root);
    return quarantine as AbsolutePath;
  }

  async quarantinePath(root: AbsolutePath, operationId: WorkspaceOperationId): Promise<AbsolutePath> {
    const source = await this.directChild(root);
    return path.join(source.root, `.${path.basename(source.target)}${QUARANTINE_MARKER}${operationId}`) as AbsolutePath;
  }

  async restoreQuarantine(quarantine: AbsolutePath, root: AbsolutePath): Promise<void> {
    const source = await this.directChild(quarantine);
    const target = await this.directChild(root);
    if (!path.basename(source.target).includes(QUARANTINE_MARKER) || await exists(target.target)) {
      throw new Error("project quarantine cannot be restored safely");
    }
    await rename(source.target, target.target);
    await syncDirectory(source.root);
  }

  async removeOwned(target: AbsolutePath): Promise<void> {
    const owned = await this.directChild(target);
    const name = path.basename(owned.target);
    const importOperationId = name.match(/\.vidcom-import-(.+)\.tmp$/u)?.[1] ?? null;
    const importMarker = importOperationId === null ? null : await readStagingMarker(owned.target);
    const importOwned = importMarker !== null && importMarker.operationId === importOperationId;
    if (!name.startsWith(".")
      || (!name.includes(CREATE_MARKER) && !name.includes(QUARANTINE_MARKER) && !importOwned)) {
      throw new Error("refusing to remove a directory not owned by VidCom");
    }
    await rm(owned.target, { recursive: true, force: true });
    await syncDirectory(owned.root);
  }

  async inspect(target: AbsolutePath): Promise<"absent" | "directory" | "invalid"> {
    const owned = await this.directChild(target);
    try {
      const value = await lstat(owned.target);
      return value.isDirectory() && !value.isSymbolicLink() ? "directory" : "invalid";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
  }
}
