import { ErrorCode, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import type { BrowseTokenStore, DirectoryIdentity } from "./browse-token-store";

export const BROWSE_PAGE_SIZE = 500;
export const MAX_BROWSE_PAGE_SIZE = 1_000;

export interface BrowseEntry {
  name: string;
  isDirectory: boolean;
  /** Present only for directories: the handle used to descend into them. */
  token?: string;
}

export interface BrowseRoot {
  /** What the user sees. Windows lists drive roots; POSIX starts at `/`. */
  displayPath: string;
  token: string;
}

export interface BrowsePage {
  displayPath: string;
  entries: readonly BrowseEntry[];
  /** Absent when this is the last page. */
  cursor?: string;
}

/** What the adapter reports for one directory read. */
export interface RawDirectoryEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export type DirectoryReadFailure =
  | "not-found"
  | "not-a-directory"
  | "permission-denied"
  | "changed"
  | "timeout";

export type DirectoryRead =
  | { ok: true; entries: readonly RawDirectoryEntry[]; identity: DirectoryIdentity }
  | { ok: false; reason: DirectoryReadFailure };

/** Everything the browser needs from the filesystem. Implemented in `adapter/fs`. */
export interface FilesystemBrowserPort {
  roots(): Promise<readonly { displayPath: string; canonicalPath: string; identity: DirectoryIdentity }[]>;
  read(canonicalPath: string): Promise<DirectoryRead>;
  identity(canonicalPath: string): Promise<DirectoryIdentity | undefined>;
  join(canonicalPath: string, name: string): Promise<string>;
  createDirectory(parentPath: string, name: string): Promise<DirectoryRead>;
}

const FAILURE_CODES: Readonly<Record<DirectoryReadFailure, ErrorCode>> = {
  "not-found": ErrorCode.NotFound,
  "not-a-directory": ErrorCode.PathInvalid,
  // Not a 500: being refused by the operating system is an answer, not a fault.
  "permission-denied": ErrorCode.PathPermissionDenied,
  "changed": ErrorCode.BrowseTokenInvalid,
  "timeout": ErrorCode.PathTimeout,
};

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

/**
 * Navigates the filesystem for an authenticated session without exposing paths.
 *
 * Every policy decision lives here and every `node:fs` call lives behind the
 * port: `core` is forbidden from importing `node:fs`, and a browser that
 * reached for it would put path policy in two places at once.
 *
 * Nothing throws. A directory that is missing, refused or slow is an ordinary
 * outcome of asking about a filesystem the user controls, and each maps to its
 * own code so a caller can say what happened rather than reporting a fault.
 */
export class FilesystemBrowserService {
  constructor(
    private readonly port: FilesystemBrowserPort,
    private readonly tokens: BrowseTokenStore,
  ) {}

  async roots(sessionId: string): Promise<Result<readonly BrowseRoot[], DomainError>> {
    const roots = await this.port.roots();
    return ok(roots.map((root) => ({
      displayPath: root.displayPath,
      token: this.tokens.mint({
        sessionId,
        canonicalPath: root.canonicalPath,
        identity: root.identity,
      }).token,
    })));
  }

  /**
   * Lists one page of a directory named by a token.
   *
   * Paged because a directory can hold hundreds of thousands of entries, and
   * returning all of them is how a browse turns into a hang.
   */
  async list(input: {
    sessionId: string;
    token: string;
    cursor?: string;
    pageSize?: number;
  }): Promise<Result<BrowsePage, DomainError>> {
    const held = await this.resolveToken(input.sessionId, input.token);
    if (!held.ok) return held;

    const read = await this.port.read(held.value.canonicalPath);
    if (!read.ok) {
      return err({
        code: FAILURE_CODES[read.reason],
        message: `the directory could not be listed: ${read.reason}`,
      });
    }
    const verified = this.tokens.resolve({
      token: input.token,
      sessionId: input.sessionId,
      currentIdentity: read.identity,
    });
    if (!verified.ok) return verified;

    const size = Math.min(Math.max(1, input.pageSize ?? BROWSE_PAGE_SIZE), MAX_BROWSE_PAGE_SIZE);
    const offset = decodeCursor(input.cursor);
    const sorted = [...read.entries].sort((left, right) => left.name.localeCompare(right.name, "en"));
    const slice = sorted.slice(offset, offset + size);

    const entries: BrowseEntry[] = [];
    for (const entry of slice) {
      // Only directories get a token: a file is a name in a listing, and minting
      // a handle for one would invite it to be used as a destination.
      if (!entry.isDirectory) {
        entries.push({ name: entry.name, isDirectory: false });
        continue;
      }
      const canonicalPath = await this.port.join(verified.value.canonicalPath, entry.name);
      const identity = await this.port.identity(canonicalPath);
      if (!identity) continue;
      entries.push({
        name: entry.name,
        isDirectory: true,
        token: this.tokens.mint({ sessionId: input.sessionId, canonicalPath, identity }).token,
      });
    }

    const next = offset + slice.length;
    return ok({
      displayPath: verified.value.canonicalPath,
      entries,
      ...next < sorted.length ? { cursor: String(next) } : {},
    });
  }

  async createDirectory(input: {
    sessionId: string;
    parentToken: string;
    name: string;
  }): Promise<Result<BrowseEntry, DomainError>> {
    const held = await this.resolveToken(input.sessionId, input.parentToken);
    if (!held.ok) return held;
    if (input.name.length === 0 || input.name.includes("/") || input.name.includes("\\")
      || input.name === "." || input.name === "..") {
      return err({ code: ErrorCode.PathInvalid, message: "directory name is not a single path segment" });
    }

    const created = await this.port.createDirectory(held.value.canonicalPath, input.name);
    if (!created.ok) {
      return err({
        code: FAILURE_CODES[created.reason],
        message: `the directory could not be created: ${created.reason}`,
      });
    }
    const canonicalPath = await this.port.join(held.value.canonicalPath, input.name);
    return ok({
      name: input.name,
      isDirectory: true,
      token: this.tokens.mint({
        sessionId: input.sessionId,
        canonicalPath,
        identity: created.identity,
      }).token,
    });
  }

  /** Turns a token into the absolute path a caller may act on. */
  async resolveSelection(input: {
    sessionId: string;
    token: string;
  }): Promise<Result<string, DomainError>> {
    const held = await this.resolveToken(input.sessionId, input.token);
    return held.ok ? ok(held.value.canonicalPath) : held;
  }

  private async resolveToken(sessionId: string, token: string) {
    // Peek to learn which path to stat, then resolve against what that path is
    // right now. The identity is read at use time, not at mint time: that
    // comparison is what makes a replaced directory fail instead of silently
    // redirecting somewhere else.
    const held = this.tokens.peek(token, sessionId);
    const current = held ? await this.port.identity(held.canonicalPath) : undefined;
    return this.tokens.resolve({ token, sessionId, currentIdentity: current });
  }
}
