import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { ContentHash } from "@vidcom/contracts";
import type { McpCredentialCryptoPort } from "@vidcom/core";

const SECRET_PREFIX = "vcmcp_";
const SECRET_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function digest(secret: string): ContentHash {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}` as ContentHash;
}

/** Node cryptography adapter for fixed-shape MCP bearer generation and verification. */
export class NodeMcpCredentialCrypto implements McpCredentialCryptoPort {
  constructor(private readonly random: (size: number) => Buffer = randomBytes) {}

  issue(): { secret: string; secretHash: ContentHash } {
    const bytes = this.random(32);
    if (bytes.byteLength !== 32) throw new Error("credential entropy source returned an invalid byte length");
    const secret = `${SECRET_PREFIX}${bytes.toString("base64url")}`;
    return { secret, secretHash: digest(secret) };
  }

  hash(secret: string): ContentHash | null {
    const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : "";
    return SECRET_BODY_PATTERN.test(body) ? digest(secret) : null;
  }

  equals(left: ContentHash, right: ContentHash): boolean {
    if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
    return timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
  }
}
