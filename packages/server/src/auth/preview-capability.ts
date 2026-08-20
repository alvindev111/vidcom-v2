import { createHash, randomBytes } from "node:crypto";

import type { ProjectId } from "@vidcom/contracts";
import type { ClockPort } from "@vidcom/core";

export const previewCapabilityPolicy = {
  bytes: 32,
  ttlMs: 5 * 60 * 1_000,
} as const;

export interface PreviewCapabilityOwner {
  projectId: ProjectId;
  browserSessionId: string;
  studioSessionId: string;
}

export interface PreviewCapabilityIssuer {
  mint(owner: PreviewCapabilityOwner): { token: string; expiresAt: string };
  revoke(owner: PreviewCapabilityOwner): void;
}

export interface PreviewCapabilityVerifier {
  verify(token: string, projectId: ProjectId): boolean;
}

interface StoredPreviewCapability extends PreviewCapabilityOwner {
  expiresAt: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Short-lived, read-only authority for one project's isolated preview origin. */
export class InMemoryPreviewCapabilityStore implements PreviewCapabilityIssuer, PreviewCapabilityVerifier {
  private readonly capabilities = new Map<string, StoredPreviewCapability>();

  constructor(
    private readonly clock: ClockPort,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {}

  mint(owner: PreviewCapabilityOwner): { token: string; expiresAt: string } {
    this.prune();
    const token = this.random(previewCapabilityPolicy.bytes).toString("base64url");
    const expiresAt = this.clock.now().getTime() + previewCapabilityPolicy.ttlMs;
    this.capabilities.set(sha256(token), { ...owner, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  verify(token: string, projectId: ProjectId): boolean {
    const key = sha256(token);
    const capability = this.capabilities.get(key);
    if (!capability) return false;
    if (this.clock.now().getTime() >= capability.expiresAt) {
      this.capabilities.delete(key);
      return false;
    }
    return capability.projectId === projectId;
  }

  revoke(owner: PreviewCapabilityOwner): void {
    for (const [key, capability] of this.capabilities) {
      if (
        capability.projectId === owner.projectId
        && capability.browserSessionId === owner.browserSessionId
        && capability.studioSessionId === owner.studioSessionId
      ) {
        this.capabilities.delete(key);
      }
    }
  }

  revokeAll(): void {
    this.capabilities.clear();
  }

  /** Test-only observability without exposing bearer values. */
  storedHashes(): readonly string[] {
    this.prune();
    return [...this.capabilities.keys()];
  }

  private prune(): void {
    const now = this.clock.now().getTime();
    for (const [key, capability] of this.capabilities) {
      if (now >= capability.expiresAt) this.capabilities.delete(key);
    }
  }
}
