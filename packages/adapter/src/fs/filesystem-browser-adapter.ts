import { homedir } from "node:os";
import path from "node:path";

import type {
  DirectoryIdentity,
  DirectoryRead,
  FilesystemBrowserPort,
  RawDirectoryEntry,
} from "@vidcom/core";

import { BrowseWorkerPool } from "./browse-worker";

type ReadFailure = "not-found" | "not-a-directory" | "permission-denied" | "timeout";

const ERROR_REASONS: Readonly<Record<string, ReadFailure>> = {
  ENOENT: "not-found",
  ENOTDIR: "not-a-directory",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  timeout: "timeout",
};

function reasonFor(code: string): ReadFailure {
  // An unknown errno is treated as not-found rather than as a fault: the caller
  // asked about a path on a filesystem it does not control, and "I could not
  // read it" is the honest answer for anything we cannot classify.
  return ERROR_REASONS[code] ?? "not-found";
}

/**
 * Reads directories through the bounded worker pool.
 *
 * Every `node:fs` call for browsing lives here. The service in `core` decides
 * what may be listed and what a caller is told; this only answers what is on
 * disk, and answers it off the event loop so one enormous directory cannot
 * stall the daemon.
 */
export class WorkerFilesystemBrowser implements FilesystemBrowserPort {
  constructor(private readonly pool: BrowseWorkerPool = new BrowseWorkerPool()) {}

  /**
   * Where a browse may start.
   *
   * Windows has no single tree, so each drive is its own root. POSIX has one,
   * and the home directory is offered beside it because that is where a user's
   * projects actually live.
   */
  async roots(): Promise<readonly { displayPath: string; canonicalPath: string; identity: DirectoryIdentity }[]> {
    const candidates = process.platform === "win32"
      ? await this.windowsDriveRoots()
      : ["/", homedir()];
    const roots: { displayPath: string; canonicalPath: string; identity: DirectoryIdentity }[] = [];
    for (const candidate of candidates) {
      const identity = await this.identity(candidate);
      if (identity) roots.push({ displayPath: candidate, canonicalPath: candidate, identity });
    }
    return roots;
  }

  private async windowsDriveRoots(): Promise<string[]> {
    const found: string[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      // Probed rather than assumed: a machine's drive letters are not knowable
      // any other way, and an absent one must not appear as an empty root.
      if (await this.identity(root)) found.push(root);
    }
    return found;
  }

  async read(canonicalPath: string): Promise<DirectoryRead> {
    const response = await this.pool.run({ kind: "read", path: canonicalPath });
    if (!response.ok) return { ok: false, reason: reasonFor(response.code) };
    const identity = await this.identity(canonicalPath);
    if (!identity) return { ok: false, reason: "not-found" };
    return { ok: true, entries: response.entries as readonly RawDirectoryEntry[], identity };
  }

  async identity(canonicalPath: string): Promise<DirectoryIdentity | undefined> {
    const response = await this.pool.run({ kind: "identity", path: canonicalPath });
    return response.ok ? response.identity as DirectoryIdentity : undefined;
  }

  async join(canonicalPath: string, name: string): Promise<string> {
    return path.join(canonicalPath, name);
  }

  async createDirectory(parentPath: string, name: string): Promise<DirectoryRead> {
    const target = path.join(parentPath, name);
    const { mkdir } = await import("node:fs/promises");
    try {
      await mkdir(target, { recursive: false });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unknown";
      // EEXIST is not a failure to report as missing: the directory the caller
      // asked for is there, which is what they wanted.
      if (code !== "EEXIST") return { ok: false, reason: reasonFor(code) };
    }
    const identity = await this.identity(target);
    if (!identity) return { ok: false, reason: "not-found" };
    return { ok: true, entries: [], identity };
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}
