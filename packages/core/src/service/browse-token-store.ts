import { ErrorCode, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";

export const BROWSE_TOKEN_TTL_MS = 60_000;

/**
 * What a directory was when a token was minted.
 *
 * The identity comes from the adapter's `stat`, not from this module: `core`
 * must not touch `node:fs`. Storing it is what lets a later request notice that
 * the path now names something else.
 */
export interface DirectoryIdentity {
  device: string;
  inode: string;
}

export interface BrowseToken {
  token: string;
  sessionId: string;
  canonicalPath: string;
  identity: DirectoryIdentity;
  expiresAt: number;
}

export interface BrowseTokenMint {
  sessionId: string;
  /** Already canonicalized by the adapter; this module never resolves paths. */
  canonicalPath: string;
  identity: DirectoryIdentity;
}

export interface BrowseTokenStoreOptions {
  now?: () => number;
  ttlMs?: number;
  newToken?: () => string;
}

/**
 * Hands out short-lived handles that stand in for absolute paths.
 *
 * A token exists so a client never sends an absolute path back to the server:
 * the path was chosen through an authenticated browse, and re-accepting it as
 * input would let any caller name any directory. Tokens are held in memory
 * only — a handle that survived a restart would outlive the session it was
 * bound to.
 *
 * Three things are bound, and all three are checked on use. The **session**,
 * so one session cannot spend another's token. The **canonical path**, which
 * the adapter resolved once. And the directory's **identity**, so a path that
 * has been replaced — a symlink repointed between two requests — invalidates
 * the token rather than silently referring somewhere new.
 */
export class BrowseTokenStore {
  private readonly tokens = new Map<string, BrowseToken>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly newToken: () => string;
  private sequence = 0;

  constructor(options: BrowseTokenStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? BROWSE_TOKEN_TTL_MS;
    this.newToken = options.newToken ?? (() => `browse_${(this.sequence += 1).toString(36)}`);
  }

  mint(input: BrowseTokenMint): BrowseToken {
    this.evictExpired();
    const token: BrowseToken = {
      token: this.newToken(),
      sessionId: input.sessionId,
      canonicalPath: input.canonicalPath,
      identity: input.identity,
      expiresAt: this.now() + this.ttlMs,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  /**
   * Resolves a token for one session, given what the directory looks like now.
   *
   * `currentIdentity` is supplied by the caller because only the adapter can
   * stat. Passing `undefined` means the directory is gone, which is as much a
   * mismatch as it having changed.
   */
  resolve(input: {
    token: string;
    sessionId: string;
    currentIdentity: DirectoryIdentity | undefined;
  }): Result<BrowseToken, DomainError> {
    this.evictExpired();
    const held = this.tokens.get(input.token);
    // One code for absent, expired and foreign tokens alike: distinguishing
    // them would tell a caller which tokens exist.
    if (!held || held.sessionId !== input.sessionId) {
      return err({ code: ErrorCode.BrowseTokenInvalid, message: "browse token is not valid" });
    }
    if (
      !input.currentIdentity
      || input.currentIdentity.device !== held.identity.device
      || input.currentIdentity.inode !== held.identity.inode
    ) {
      // The path now names something else. Honouring the token here is the
      // TOCTOU this binding exists to close.
      this.tokens.delete(input.token);
      return err({
        code: ErrorCode.BrowseTokenInvalid,
        message: "the directory this token referred to has changed",
      });
    }
    return ok(held);
  }

  /**
   * Reads a token's path without checking the directory's identity.
   *
   * Needed because the identity comparison requires stat'ing the path, and the
   * path is only known from the token. Callers MUST follow this with `resolve`;
   * peeking alone proves nothing about what the path names now.
   */
  peek(token: string, sessionId: string): BrowseToken | undefined {
    this.evictExpired();
    const held = this.tokens.get(token);
    return held && held.sessionId === sessionId ? held : undefined;
  }

  /** Drops every token belonging to a session that has ended. */
  revokeSession(sessionId: string): void {
    for (const [key, held] of this.tokens) {
      if (held.sessionId === sessionId) this.tokens.delete(key);
    }
  }

  size(): number {
    this.evictExpired();
    return this.tokens.size;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, held] of this.tokens) {
      if (held.expiresAt <= now) this.tokens.delete(key);
    }
  }
}
