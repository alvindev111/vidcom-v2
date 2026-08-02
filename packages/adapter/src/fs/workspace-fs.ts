import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  type AbsolutePath,
  type FileContent,
  type FileNode,
  type FileStat,
  type JournalId,
  type MutationCapture,
  type PathPurpose,
  type PathRejection,
  type ProjectRef,
  type ResolvedPath,
  type Result,
  type WorkspacePort,
  type ProjectCandidate,
  type ProjectRegistration,
} from "@vidcom/core";

import { writeAtomic } from "./atomic-write";
import { deleteAtomic } from "./atomic-delete";
import { resolveProjectPath } from "./resolve";
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
    const [config, identity] = await Promise.all([
      stat(path.join(directory, "hyperframes.json")),
      readFile(path.join(directory, "vidcom.json"), "utf8"),
      stat(path.join(directory, "index.html")),
    ]);
    if (!config.isFile()) return null;
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

/** Node filesystem implementation scoped to one injected workspace root. */
export class WorkspaceFs implements WorkspacePort {
  constructor(private readonly workspaceRoot: AbsolutePath) {}

  /** Resolves and authorizes a path with canonical symlink containment checks. */
  resolve(
    ref: ProjectRef,
    relativePath: string,
    purpose: PathPurpose,
  ): Promise<Result<ResolvedPath, PathRejection>> {
    return resolveProjectPath(ref, relativePath, purpose);
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
      return sha256(await readFile(pathname));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Atomically replaces one resolved target without checking a write precondition. */
  writeAtomic(pathname: ResolvedPath, content: string | Uint8Array): Promise<void> {
    return writeAtomic(pathname, content);
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
  captureForMutation(
    pathname: ResolvedPath,
    expectedHash: ContentHash | null,
    journalId: JournalId,
    ordinal: number,
  ) {
    return captureForMutation(pathname, expectedHash, journalId, ordinal);
  }

  /** Publishes bytes without replacing a target created after capture. */
  publishCaptured(capture: MutationCapture, content: string | Uint8Array | null): Promise<boolean> {
    return publishCaptured(capture, content);
  }

  /** Restores captured bytes only while the live target still matches the landed mutation hash. */
  restoreCaptured(capture: MutationCapture, landedHash: ContentHash | null): Promise<boolean> {
    return restoreCaptured(capture, landedHash);
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
      const value = await stat(pathname);
      return {
        size: value.size,
        modifiedAt: value.mtime,
        kind: value.isDirectory() ? "directory" : "file",
      };
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
  } catch {
    return false;
  }
}
