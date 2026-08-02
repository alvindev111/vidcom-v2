import { describe, expect, it, vi } from "vitest";

import type { ContentHash } from "@vidcom/contracts";
import {
  DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS,
  MAX_CREDENTIAL_ROTATION_OVERLAP_MS,
  McpCredentialService,
  type McpCredentialCryptoPort,
  type McpCredentialPort,
  type McpCredentialRecord,
} from "@vidcom/core";

const now = "2026-08-02T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}` as ContentHash;
const ECMASCRIPT_DATE_MAX_MS = 8_640_000_000_000_000;

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

function fixture(options: { now?: Date; rotationOverlapMs?: number } = {}) {
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
    clock: { now: () => options.now ?? new Date(now) },
    ids: { newId: () => `credential_${++id}` },
    ...(options.rotationOverlapMs === undefined
      ? {}
      : { config: { rotationOverlapMs: options.rotationOverlapMs } }),
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

  it("lists public lifecycle summaries without verifier hashes", async () => {
    const { service } = fixture();
    await service.issue("host");
    await expect(service.list()).resolves.toEqual([{
      id: "credential_1",
      label: "host",
      status: "active",
      createdAt: now,
      rotatedFrom: null,
      expiresAt: null,
    }]);
    expect(JSON.stringify(await service.list())).not.toContain(digest);
  });

  it("bounds configured and explicit overlap and rejects expiry outside the Date range", async () => {
    expect(() => fixture({ rotationOverlapMs: MAX_CREDENTIAL_ROTATION_OVERLAP_MS + 1 }))
      .toThrow(`credential rotation overlap must be an integer between 0 and ${MAX_CREDENTIAL_ROTATION_OVERLAP_MS}`);

    const maximum = fixture({ rotationOverlapMs: MAX_CREDENTIAL_ROTATION_OVERLAP_MS });
    const original = await maximum.service.issue("host");
    await maximum.service.rotate(original.id);
    expect(maximum.credentials.rotateCalls[0]?.expiresAt).toBe("2026-08-03T00:00:00.000Z");

    const beyond = fixture();
    const beyondOriginal = await beyond.service.issue("host");
    await expect(beyond.service.rotate(beyondOriginal.id, MAX_CREDENTIAL_ROTATION_OVERLAP_MS + 1))
      .rejects.toBeInstanceOf(TypeError);
    expect(beyond.credentials.rotateCalls).toEqual([]);

    const dateEdge = fixture({ now: new Date(ECMASCRIPT_DATE_MAX_MS - 1_000) });
    const edgeOriginal = await dateEdge.service.issue("host");
    await expect(dateEdge.service.rotate(edgeOriginal.id, 1_001))
      .rejects.toThrow("credential rotation expiry is outside the ECMAScript Date range");
    expect(dateEdge.credentials.rotateCalls).toEqual([]);
  });
});
