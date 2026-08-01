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

  revokeAll(): void {
    this.sessions.clear();
  }

  /** Test-only observability without exposing raw tokens. */
  storedHashes(): readonly string[] {
    return [...this.sessions.keys()];
  }
}

export const sessionPolicy = {
  bytes: 32,
  absoluteTtlMs: 12 * 60 * 60 * 1_000,
  idleTtlMs: 2 * 60 * 60 * 1_000,
} as const;
