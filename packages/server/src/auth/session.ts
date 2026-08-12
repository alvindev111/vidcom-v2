import { createHash, randomBytes } from "node:crypto";

import type { ClockPort, SessionPort } from "@vidcom/core";

interface StoredSession {
  expiresAt: number;
  idleTtlMs: number;
  lastSeenAt: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Opaque stable key used to bind secondary capabilities to one browser session. */
export function sessionFingerprint(token: string): string {
  return `browser:${sha256(token)}`;
}

/** SessionPort implementation whose raw bearer values never enter storage. */
export class InMemorySessionStore implements SessionPort {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(
    private readonly clock: ClockPort,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {}

  mint(options: { absoluteTtlMs: number; idleTtlMs: number }): { token: string } {
    const token = this.random(32).toString("base64url");
    const now = this.clock.now().getTime();
    this.sessions.set(sha256(token), {
      expiresAt: now + options.absoluteTtlMs,
      idleTtlMs: options.idleTtlMs,
      lastSeenAt: now,
    });
    return { token };
  }

  verify(token: string): { valid: boolean; renewed: boolean } {
    const key = sha256(token);
    const session = this.sessions.get(key);
    if (!session) return { valid: false, renewed: false };

    const now = this.clock.now().getTime();
    if (now >= session.expiresAt || now - session.lastSeenAt >= session.idleTtlMs) {
      this.sessions.delete(key);
      return { valid: false, renewed: false };
    }

    session.lastSeenAt = now;
    return { valid: true, renewed: true };
  }

  /** Stable opaque identity for a currently valid browser session. */
  fingerprint(token: string): string | undefined {
    const key = sha256(token);
    const session = this.sessions.get(key);
    if (!session || this.expired(session)) {
      this.sessions.delete(key);
      return undefined;
    }
    return sessionFingerprint(token);
  }

  /** Prunes expired sessions before answering daemon lifecycle decisions. */
  hasActiveSessions(): boolean {
    for (const [key, session] of this.sessions) {
      if (this.expired(session)) this.sessions.delete(key);
    }
    return this.sessions.size > 0;
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  /** Test-only observability without exposing raw tokens. */
  storedHashes(): readonly string[] {
    return [...this.sessions.keys()];
  }

  private expired(session: StoredSession): boolean {
    const now = this.clock.now().getTime();
    return now >= session.expiresAt || now - session.lastSeenAt >= session.idleTtlMs;
  }
}

export const sessionPolicy = {
  bytes: 32,
  absoluteTtlMs: 12 * 60 * 60 * 1_000,
  idleTtlMs: 2 * 60 * 60 * 1_000,
} as const;
