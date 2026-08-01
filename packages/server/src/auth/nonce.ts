import { randomBytes } from "node:crypto";

import type { ClockPort } from "@vidcom/core";

const NONCE_BYTES = 32;
const NONCE_TTL_MS = 60_000;

export interface NonceSource {
  issue(): string;
  consume(nonce: string): boolean;
}

/** Process-local, single-use browser bootstrap nonces. */
export class InMemoryNonceStore implements NonceSource {
  private readonly nonces = new Map<string, number>();

  constructor(
    private readonly clock: ClockPort,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {}

  issue(): string {
    const nonce = this.random(NONCE_BYTES).toString("base64url");
    this.register(nonce);
    return nonce;
  }

  /** Registers a CLI-generated nonce after verifying its required entropy width. */
  register(nonce: string): void {
    if (Buffer.from(nonce, "base64url").byteLength !== NONCE_BYTES) {
      throw new Error("browser bootstrap nonce must contain exactly 32 bytes");
    }
    this.nonces.set(nonce, this.clock.now().getTime() + NONCE_TTL_MS);
  }

  consume(nonce: string): boolean {
    const expiresAt = this.nonces.get(nonce);
    if (expiresAt === undefined) return false;

    // Delete before the caller can mint a session, so concurrent exchanges cannot both win.
    this.nonces.delete(nonce);
    return this.clock.now().getTime() < expiresAt;
  }
}

export const noncePolicy = {
  bytes: NONCE_BYTES,
  ttlMs: NONCE_TTL_MS,
} as const;
