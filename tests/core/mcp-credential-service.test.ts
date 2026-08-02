import { describe, expect, it, vi } from "vitest";

import type { ContentHash } from "@vidcom/contracts";
import {
  DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS,
  McpCredentialService,
  type McpCredentialCryptoPort,
  type McpCredentialPort,
  type McpCredentialRecord,
} from "@vidcom/core";

const now = "2026-08-02T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}` as ContentHash;

class MemoryCredentialStore implements McpCredentialPort {
  readonly records = new Map<string, McpCredentialRecord>();
  readonly rotateCalls: Array<{ id: string; replacement: McpCredentialRecord; expiresAt: string }> = [];

  async create(record: McpCredentialRecord): Promise<void> { this.records.set(record.id, record); }
  async findUsableByHash(secretHash: ContentHash): Promise<McpCredentialRecord | null> {
    return [...this.records.values()].find((record) => record.secretHash === secretHash) ?? null;
  }
  async read(id: string): Promise<McpCredentialRecord | null> { return this.records.get(id) ?? null; }
  async list(): Promise<McpCredentialRecord[]> { return [...this.records.values()]; }
  async rotate(id: string, replacement: McpCredentialRecord, expiresAt: string): Promise<boolean> {
    this.rotateCalls.push({ id, replacement, expiresAt });
    const current = this.records.get(id);
    if (current?.status !== "active") return false;
    this.records.set(id, { ...current, status: "rotating", expiresAt });
    this.records.set(replacement.id, replacement);
    return true;
  }
  async revoke(id: string): Promise<boolean> {
    const current = this.records.get(id);
    if (!current || current.status === "revoked") return false;
    this.records.set(id, { ...current, status: "revoked", expiresAt: null });
    return true;
  }
}

function fixture() {
  const credentials = new MemoryCredentialStore();
  const crypto: McpCredentialCryptoPort = {
    issue: vi.fn(() => ({ secret: "vcmcp_secret", secretHash: digest })),
    hash: vi.fn((secret) => secret === "vcmcp_secret" ? digest : null),
    equals: vi.fn((left, right) => left === right),
  };
  let id = 0;
  const service = new McpCredentialService({
    credentials,
    crypto,
    clock: { now: () => new Date(now) },
    ids: { newId: () => `credential_${++id}` },
  });
  return { credentials, crypto, service };
}

describe("McpCredentialService", () => {
  it("keeps the one-time plaintext outside the persistence record", async () => {
    const { credentials, service } = fixture();
    const issued = await service.issue("host");
    expect(issued).toEqual({ id: "credential_1", secret: "vcmcp_secret" });
    expect(JSON.stringify(await credentials.read(issued.id))).not.toContain(issued.secret);
  });

  it("does no lookup for malformed shape and timing-compares a usable digest", async () => {
    const { credentials, crypto, service } = fixture();
    const lookup = vi.spyOn(credentials, "findUsableByHash");
    await service.issue("host");
    await expect(service.verify("malformed")).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    await expect(service.verify("vcmcp_secret")).resolves.toEqual({ id: "credential_1" });
    expect(crypto.equals).toHaveBeenCalledWith(digest, digest);
  });

  it("creates a linked replacement with the default exact overlap", async () => {
    const { credentials, service } = fixture();
    const original = await service.issue("host");
    const replacement = await service.rotate(original.id);
    expect(replacement.id).toBe("credential_2");
    expect(credentials.rotateCalls).toEqual([{
      id: original.id,
      replacement: expect.objectContaining({ id: replacement.id, rotatedFrom: original.id, status: "active" }),
      expiresAt: new Date(new Date(now).getTime() + DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS).toISOString(),
    }]);
  });
});
