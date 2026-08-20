import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  type AbsolutePath,
  type BackupSource,
  type FileContent,
  type FileNode,
  type FileStat,
  type JournalId,
  type WorkspaceOperationId,
  type MutationCapture,
  type MutationPathLease,
  type PathPurpose,
  type PathRejection,
  type ProjectRef,
  type ResolvedPath,
  type Result,
  type StagedSourceHandle,
  type WorkspacePort,
  type ProjectCandidate,
  type ProjectRegistration,
} from "@vidcom/core";

import { writeAtomic } from "./atomic-write";
import { openRegularFileNoFollow } from "./regular-file";
import { deleteAtomic } from "./atomic-delete";
import { syncDirectory } from "./durability";
import {
  resolveMutationPath,
  resolveProjectPath,
  resolveWorkspacePath,
  refreshMutationPath,
  revalidateMutationPath,
} from "./resolve";
import {
  captureForMutation,
  discardCapture,
  publishCaptured,
  restoreCaptured,
} from "./mutation-capture";

const IGNORED_TREE_ENTRIES = new Set(["node_modules", ".git", ".hyperframes"]);

function sha256(content: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
}

async function readProjectRefAt(directory: string, slug: string): Promise<ProjectRef | null> {
  try {
    const handle = await open(path.join(directory, "vidcom.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let identity: string;
    try {
      if (!(await handle.stat()).isFile()) return null;
      identity = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(identity) as { id?: unknown };
    if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    return {
      id: parsed.id as ProjectId,
      slug,
      root: directory as AbsolutePath,
      entry: "index.html" as RelPath,
    };
  } catch {
    return null;
  }
}

async function hashRegularFile(pathname: string): Promise<ContentHash> {
  const handle = await openRegularFileNoFollow(pathname, "hash target is not a regular file");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError("hash target is not a regular file");
    const digest = createHash("sha256");
    // Tree mutations may hash hundreds of small files before V8 collects their
    // backing stores. Keep each streaming allocation bounded so file count does
    // not become an RSS multiplier while large files still use one fixed buffer.
    const buffer = Buffer.allocUnsafe(16 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${digest.digest("hex")}` as ContentHash;
  } finally {
    await handle.close();
  }
}

/** Node filesystem implementation scoped to one injected workspace root. */
export class WorkspaceFs implements WorkspacePort {
  private readonly directProjectRootChecks = new Map<AbsolutePath, Promise<string>>();
  private readonly workspaceRootCanonical: Promise<string>;

  constructor(private readonly workspaceRoot: AbsolutePath) {
    this.workspaceRootCanonical = realpath(workspaceRoot);
  }

  private async directProjectRoot(root: AbsolutePath): Promise<string> {
    const active = this.directProjectRootChecks.get(root);
    if (active) return active;
    const check = Promise.all([realpath(root), this.workspaceRootCanonical]).then(([project, workspace]) => {
      if (path.dirname(project) !== workspace) throw new TypeError("project root is not a direct workspace child");
      return project;
    });
    this.directProjectRootChecks.set(root, check);
    try {
      return await check;
    } finally {
      if (this.directProjectRootChecks.get(root) === check) this.directProjectRootChecks.delete(root);
    }
  }

  async listWorkspaceDirectories(root: AbsolutePath): Promise<Array<{ slug: string; root: AbsolutePath }>> {
    const [requested, owned] = await Promise.all([realpath(root), this.workspaceRootCanonical]);
    if (requested !== owned) throw new TypeError("workspace root does not match the injected capability");
    return (await readdir(owned, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({ slug: entry.name, root: path.join(owned, entry.name) as AbsolutePath }));
  }

  async statWorkspaceFile(
    root: AbsolutePath,
    filename: "vidcom.json" | "hyperframes.json" | "index.html",
  ): Promise<{ size: number; modifiedAtMs: number } | null> {
    const project = await this.directProjectRoot(root);
    try {
      const value = await lstat(path.join(project, filename));
      return value.isFile() && !value.isSymbolicLink()
        ? { size: value.size, modifiedAtMs: value.mtimeMs }
        : null;
    } catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  }

  async readWorkspaceFile(
    root: AbsolutePath,
    filename: "vidcom.json" | "hyperframes.json" | "index.html",
  ): Promise<FileContent | null> {
    const project = await this.directProjectRoot(root);
    try {
      const handle = await open(path.join(project, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) return null;
        const content = await handle.readFile("utf8");
        return { content, contentHash: sha256(content) };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  }

  /** Resolves and authorizes a path with canonical symlink containment checks. */
  resolve(
    ref: ProjectRef,
    relativePath: string,
    purpose: PathPurpose,
  ): Promise<Result<ResolvedPath, PathRejection>> {
    return resolveProjectPath(ref, relativePath, purpose);
  }

  resolveMutation(
    ref: ProjectRef,
    relativePath: string,
    purpose: PathPurpose,
  ): Promise<Result<MutationPathLease, PathRejection>> {
    return resolveMutationPath(ref, relativePath, purpose);
  }

  revalidateMutationPath(lease: MutationPathLease): Promise<boolean> {
    return revalidateMutationPath(lease);
  }

  refreshMutationPath(
    lease: MutationPathLease,
    restoredParent: ResolvedPath,
  ): Promise<MutationPathLease | null> {
    return refreshMutationPath(lease, restoredParent);
  }

  async resolveWorkspace(
    workspaceRoot: AbsolutePath,
    relativePath: RelPath,
    purpose: "workspace-agent-kit",
  ): Promise<Result<ResolvedPath, PathRejection>> {
    const [injected, requested] = await Promise.all([
      realpath(this.workspaceRoot),
      realpath(workspaceRoot),
    ]);
    if (injected !== requested) return { ok: false, error: { reason: "outside_project" } };
    return resolveWorkspacePath(this.workspaceRoot, relativePath, purpose);
  }

  /** Lists valid marker-backed projects in deterministic slug order. */
  async listProjects(): Promise<ProjectRef[]> {
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => readProjectRefAt(path.join(this.workspaceRoot, entry.name), entry.name)),
    );
    return projects.filter((project): project is ProjectRef => project !== null);
  }

  /** Lists marker-backed project directories even when `vidcom.json` is missing or invalid. */
  async listProjectCandidates(): Promise<ProjectCandidate[]> {
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry): Promise<ProjectCandidate | null> => {
          const root = path.join(this.workspaceRoot, entry.name);
          try {
            const [config, index] = await Promise.all([
              stat(path.join(root, "hyperframes.json")),
              stat(path.join(root, "index.html")),
            ]);
            return config.isFile() && index.isFile()
              ? {
                  workspaceRoot: this.workspaceRoot,
                  root: root as AbsolutePath,
                  slug: entry.name,
                  entry: "index.html" as RelPath,
                }
              : null;
          } catch {
            return null;
          }
        }),
    );
    return candidates.filter((candidate): candidate is ProjectCandidate => candidate !== null);
  }

  /** Reads one project by stable ID; `null` means it is absent from this workspace. */
  async readProjectRef(id: ProjectId): Promise<ProjectRef | null> {
    return (await this.listProjects()).find((project) => project.id === id) ?? null;
  }

  /** Reads UTF-8 content and its sha256 digest; `null` means the file is absent. */
  async readFile(pathname: ResolvedPath): Promise<FileContent | null> {
    try {
      const content = await readFile(pathname, "utf8");
      return { content, contentHash: sha256(content) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Reads binary bytes and digest for assets without UTF-8 coercion. */
  async readBytes(pathname: ResolvedPath) {
    try {
      const bytes = await readFile(pathname);
      return { bytes, contentHash: sha256(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Streams file bytes through sha256; `null` means the file is absent. */
  async readHash(pathname: ResolvedPath): Promise<ContentHash | null> {
    try {
      return await hashRegularFile(pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async openStagedSource(
    ref: ProjectRef,
    sourcePath: RelPath,
    expectedHash: ContentHash,
  ): Promise<StagedSourceHandle> {
    const project = await this.directProjectRoot(ref.root);
    const resolved = await this.resolveMutation(ref, sourcePath, "authored-write");
    if (!resolved.ok) throw new TypeError("staged source path is not allowed");
    if (!(await this.revalidateMutationPath(resolved.value))) {
      throw new TypeError("staged source parent identity changed");
    }
    const sourceMetadata = await lstat(resolved.value.target);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new TypeError("staged source is not a regular file");
    }
    const stateRoot = path.join(project, ".vidcom");
    const temporaryRoot = path.join(stateRoot, "tmp");
    for (const directory of [stateRoot, temporaryRoot]) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError("staged source directory is unsafe");
      }
    }
    const temporary = path.join(temporaryRoot, `entry-${randomUUID()}.tmp`) as AbsolutePath;
    await link(resolved.value.target, temporary);
    let discarded = false;
    try {
      if (await hashRegularFile(temporary) !== expectedHash) throw new TypeError("staged source hash changed");
      await syncDirectory(temporaryRoot);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return {
      source: { sourcePath: temporary, contentHash: expectedHash },
      async discard() {
        if (discarded) return;
        await rm(temporary, { force: true });
        await syncDirectory(temporaryRoot);
        discarded = true;
      },
    };
  }

  /** Atomically replaces one resolved target without checking a write precondition. */
  writeAtomic(pathname: ResolvedPath, content: string | Uint8Array): Promise<void> {
    return writeAtomic(pathname, content);
  }

  async appendAtomic(pathname: ResolvedPath, line: string): Promise<void> {
    const parent = path.dirname(pathname);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const handle = await open(pathname, "a", 0o600);
    try {
      await handle.write(line.endsWith("\n") ? line : `${line}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(parent);
  }

  async listProjectFiles(
    ref: ProjectRef,
    directory: RelPath,
  ): Promise<Array<{ path: RelPath; modifiedAtMs: number }>> {
    const resolved = await this.resolve(ref, directory, "state-write");
    if (!resolved.ok) throw new TypeError(`project state directory is not allowed: ${resolved.error.reason}`);
    try {
      const entries = await readdir(resolved.value, { withFileTypes: true });
      return Promise.all(entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => ({
          path: `${directory}/${entry.name}` as RelPath,
          modifiedAtMs: (await stat(path.join(resolved.value, entry.name))).mtimeMs,
        })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async ensureProjectStateDirectories(ref: ProjectRef): Promise<void> {
    const project = await realpath(ref.root);
    const workspace = await realpath(this.workspaceRoot);
    if (path.dirname(project) !== workspace) throw new TypeError("project root is not a direct workspace child");
    const stateRoot = path.join(project, ".vidcom");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await Promise.all(["context", "jobs", "revisions", "logs", "cache"].map((name) =>
      mkdir(path.join(stateRoot, name), { recursive: true, mode: 0o700 })));
    await syncDirectory(stateRoot);
  }

  async listBackupSources(ref: ProjectRef): Promise<BackupSource[]> {
    return this.listBackupSourcesAt(ref.root);
  }

  async listBackupSourcesAt(root: AbsolutePath): Promise<BackupSource[]> {
    const project = await this.directProjectRoot(root);
    const sources: BackupSource[] = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (directory === project && entry.name === ".vidcom") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          sources.push({
            path: path.relative(project, absolute).split(path.sep).join("/") as RelPath,
            resolved: absolute as ResolvedPath,
          });
        }
      }
    };
    await walk(project);
    return sources;
  }

  /** Checks whether a resolved filesystem target currently exists. */
  async exists(pathname: ResolvedPath): Promise<boolean> {
    try {
      await stat(pathname);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Atomically removes one resolved file and fsyncs its containing directory. */
  deleteAtomic(pathname: ResolvedPath): Promise<void> {
    return deleteAtomic(pathname);
  }

  /** Moves the live target into a journal-owned rollback slot and verifies its hash at that boundary. */
  async captureForMutation(
    pathname: ResolvedPath,
    expectation: Parameters<WorkspacePort["captureForMutation"]>[1],
    journalId: JournalId | WorkspaceOperationId,
    ordinal: number,
    options?: Parameters<WorkspacePort["captureForMutation"]>[4],
  ) {
    if (options?.lease
      && (options.lease.target !== pathname || !await this.revalidateMutationPath(options.lease))) {
      return { ok: false as const, error: { actualState: "other" as const } };
    }
    return captureForMutation(pathname, expectation, journalId, ordinal, options);
  }

  /** Publishes bytes without replacing a target created after capture. */
  async publishCaptured(capture: MutationCapture, content: Parameters<WorkspacePort["publishCaptured"]>[1]): Promise<boolean> {
    if (capture.lease && !(await this.revalidateMutationPath(capture.lease))) return false;
    return publishCaptured(capture, content);
  }

  /** Restores captured bytes only while the live target still matches the landed mutation hash. */
  async restoreCaptured(capture: MutationCapture, landedState: Parameters<WorkspacePort["restoreCaptured"]>[1]): Promise<boolean> {
    if (capture.lease && !(await this.revalidateMutationPath(capture.lease))) return false;
    return restoreCaptured(capture, landedState);
  }

  /** Removes a terminal mutation's rollback slot. */
  discardCapture(capture: MutationCapture): Promise<void> {
    return discardCapture(capture);
  }

  /** Reads a deterministic project-relative tree without following directory symlinks. */
  async readTree(ref: ProjectRef): Promise<FileNode[]> {
    const walk = async (directory: string): Promise<FileNode[]> => {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => !IGNORED_TREE_ENTRIES.has(entry.name))
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .sort((left, right) => {
          if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
      return Promise.all(
        entries.map(async (entry): Promise<FileNode> => {
          const absolute = path.join(directory, entry.name);
          const relative = path.relative(ref.root, absolute).split(path.sep).join("/") as RelPath;
          return entry.isDirectory()
            ? { path: relative, name: entry.name, kind: "folder", children: await walk(absolute) }
            : { path: relative, name: entry.name, kind: "file" };
        }),
      );
    };
    return walk(ref.root);
  }

  /** Reads portable metadata; `null` means the resolved path is absent. */
  async stat(pathname: ResolvedPath): Promise<FileStat | null> {
    try {
      const value = await lstat(pathname);
      return {
        size: value.size,
        modifiedAt: value.mtime,
        kind: value.isDirectory()
          ? "directory"
          : value.isFile()
            ? "file"
            : value.isSymbolicLink() ? "symlink" : "other",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readDirectory(pathname: ResolvedPath) {
    try {
      return (await readdir(pathname, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory()
          ? "directory" as const
          : entry.isFile()
            ? "file" as const
            : entry.isSymbolicLink() ? "symlink" as const : "other" as const,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

/** Checks whether the registered project directory still exists with required markers. */
export async function projectRegistrationLocationExists(
  registration: ProjectRegistration,
): Promise<boolean> {
  const root = path.join(registration.workspaceRoot, registration.slug);
  try {
    const [config, index] = await Promise.all([
      stat(path.join(root, "hyperframes.json")),
      stat(path.join(root, "index.html")),
    ]);
    return config.isFile() && index.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
