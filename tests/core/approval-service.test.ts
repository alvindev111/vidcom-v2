import { describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  ApprovalService,
  DEFAULT_APPROVAL_REQUEST_TTL_MS,
  type ApprovalGrantPort,
  type ApprovalGrantRecord,
  type GrantBinding,
} from "@vidcom/core";

const hash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}` as ContentHash;
const binding: GrantBinding = {
  tool: "delete_scene",
  projectId: "project-approval" as ProjectId,
  target: "scene-1",
  expectedRevision: 4,
  planDigest: hash("a"),
  targetHashes: {
    ["z.html" as RelPath]: hash("2"),
    ["a.html" as RelPath]: hash("1"),
  },
};

class FakeGrants implements ApprovalGrantPort {
  records: ApprovalGrantRecord[] = [];
  async create(record: ApprovalGrantRecord) { this.records.push(record); }
  async read(id: string) { return this.records.find((record) => record.id === id) ?? null; }
  async issue(id: string, approver: "ui" | "cli", _issuedAt: string, expiresAt: string) {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record || record.status !== "requested") return null;
    record.status = "issued";
    record.approver = approver;
    record.expiresAt = expiresAt;
    return record;
  }
  async revoke(id: string) {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record || record.status !== "issued") return false;
    record.status = "revoked";
    return true;
  }
  async matches(id: string, expected: GrantBinding, now: string) {
    const record = this.records.find((candidate) => candidate.id === id);
    return Boolean(record && record.status === "issued" && record.expiresAt > now
      && JSON.stringify(record.binding) === JSON.stringify(expected));
  }
  async expireDue(now: string) {
    let changed = 0;
    for (const record of this.records) {
      if (["requested", "issued"].includes(record.status) && record.expiresAt <= now) {
        record.status = "expired";
        changed += 1;
      }
    }
    return changed;
  }
  async cleanupTerminal(expiresBefore: string) {
    const before = this.records.length;
    this.records = this.records.filter((record) =>
      !["consumed", "expired", "revoked", "invalidated"].includes(record.status)
      || record.expiresAt >= expiresBefore);
    return before - this.records.length;
  }
}

describe("ApprovalService request", () => {
  it("persists a canonical request with deterministic ID, clock and default TTL", async () => {
    const grants = new FakeGrants();
    const now = new Date("2026-08-02T00:00:00.000Z");
    const service = new ApprovalService({
      grants,
      clock: { now: () => now },
      ids: { newId: (prefix) => `${prefix}_0001` },
    });
    await expect(service.request(binding, "Delete scene 1")).resolves.toBe("grant_0001");
    expect(grants.records).toEqual([{
      id: "grant_0001",
      binding: {
        ...binding,
        targetHashes: { ["a.html" as RelPath]: hash("1"), ["z.html" as RelPath]: hash("2") },
      },
      summary: "Delete scene 1",
      status: "requested",
      approver: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEFAULT_APPROVAL_REQUEST_TTL_MS).toISOString(),
    }]);
  });

  it("honors an injected request TTL", async () => {
    const grants = new FakeGrants();
    const service = new ApprovalService({
      grants,
      clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
      ids: { newId: () => "grant_custom" },
      config: { requestTtlMs: 1_000 },
    });
    await service.request(binding, "Custom TTL");
    expect(grants.records[0]?.expiresAt).toBe("2026-08-02T00:00:01.000Z");
  });

  it("issues an unexpired request through CAS with the default grant TTL", async () => {
    const grants = new FakeGrants();
    const now = new Date("2026-08-02T00:00:00.000Z");
    grants.records.push({
      id: "grant_issue",
      binding,
      summary: "Issue",
      status: "requested",
      approver: null,
      createdAt: now.toISOString(),
      expiresAt: "2026-08-02T00:10:00.000Z",
    });
    const service = new ApprovalService({ grants, clock: { now: () => now }, ids: { newId: () => "unused" } });
    await expect(service.issue("grant_issue", "cli")).resolves.toEqual({ ok: true, value: "grant_issue" });
    expect(grants.records[0]).toMatchObject({
      status: "issued",
      approver: "cli",
      expiresAt: "2026-08-02T00:05:00.000Z",
    });
  });

  it("rejects expired and non-requested issue attempts", async () => {
    const grants = new FakeGrants();
    const now = new Date("2026-08-02T00:10:00.000Z");
    grants.records.push({
      id: "grant_expired",
      binding,
      summary: "Expired",
      status: "requested",
      approver: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      expiresAt: now.toISOString(),
    });
    const service = new ApprovalService({ grants, clock: { now: () => now }, ids: { newId: () => "unused" } });
    await expect(service.issue("grant_expired", "ui")).resolves.toMatchObject({
      ok: false,
      error: { code: "approval_expired" },
    });
    grants.records[0]!.status = "revoked";
    await expect(service.issue("grant_expired", "ui")).resolves.toMatchObject({
      ok: false,
      error: { code: "approval_invalid" },
    });
  });

  it("plans a canonical reserve while leaving T1 as the final authority", async () => {
    const grants = new FakeGrants();
    grants.records.push({
      id: "grant_ready",
      binding: {
        ...binding,
        targetHashes: { ["a.html" as RelPath]: hash("1"), ["z.html" as RelPath]: hash("2") },
      },
      summary: "Ready",
      status: "issued",
      approver: "cli",
      createdAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-08-02T00:05:00.000Z",
    });
    const service = new ApprovalService({
      grants,
      clock: { now: () => new Date("2026-08-02T00:01:00.000Z") },
      ids: { newId: () => "unused" },
    });
    await expect(service.planReserve("grant_ready", binding)).resolves.toEqual({
      ok: true,
      value: {
        kind: "reserve",
        grantId: "grant_ready",
        binding: {
          ...binding,
          targetHashes: { ["a.html" as RelPath]: hash("1"), ["z.html" as RelPath]: hash("2") },
        },
      },
    });
    expect(grants.records[0]?.status).toBe("issued");
  });

  it("maps expiry, revision conflict and binding mismatch before T1", async () => {
    const grants = new FakeGrants();
    const record: ApprovalGrantRecord = {
      id: "grant_map",
      binding: {
        ...binding,
        targetHashes: { ["a.html" as RelPath]: hash("1"), ["z.html" as RelPath]: hash("2") },
      },
      summary: "Map",
      status: "issued",
      approver: "ui",
      createdAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-08-02T00:05:00.000Z",
    };
    grants.records.push(record);
    const service = new ApprovalService({
      grants,
      clock: { now: () => new Date("2026-08-02T00:01:00.000Z") },
      ids: { newId: () => "unused" },
    });
    await expect(service.planReserve("grant_map", { ...binding, expectedRevision: 5 }))
      .resolves.toMatchObject({ ok: false, error: { code: "write_conflict" } });
    await expect(service.planReserve("grant_map", { ...binding, target: "scene-2" }))
      .resolves.toMatchObject({ ok: false, error: { code: "approval_invalid" } });
    record.expiresAt = "2026-08-02T00:01:00.000Z";
    await expect(service.planReserve("grant_map", binding))
      .resolves.toMatchObject({ ok: false, error: { code: "approval_expired" } });
  });

  it("revokes only issued grants and delegates terminal retention", async () => {
    const grants = new FakeGrants();
    grants.records.push({
      id: "grant_revoke",
      binding,
      summary: "Revoke",
      status: "issued",
      approver: "cli",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:05:00.000Z",
    });
    const service = new ApprovalService({
      grants,
      clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
      ids: { newId: () => "unused" },
    });
    await expect(service.revoke("grant_revoke")).resolves.toEqual({ ok: true, value: undefined });
    await expect(service.revoke("grant_revoke")).resolves.toMatchObject({
      ok: false,
      error: { code: "approval_invalid" },
    });
    await expect(service.cleanupTerminal(new Date("2026-08-02T00:00:00.000Z"))).resolves.toBe(1);
    expect(grants.records).toEqual([]);
  });

  it("expires due requested and issued grants before retention while preserving reserved rows", async () => {
    const grants = new FakeGrants();
    for (const status of ["requested", "issued", "reserved"] as const) {
      grants.records.push({
        id: `grant_${status}`,
        binding,
        summary: status,
        status,
        approver: status === "requested" ? null : "cli",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:05:00.000Z",
      });
    }
    const service = new ApprovalService({
      grants,
      clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
      ids: { newId: () => "unused" },
    });

    await expect(service.cleanupTerminal(new Date("2026-07-01T00:00:00.000Z"))).resolves.toBe(0);
    expect(grants.records.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "grant_requested", status: "expired" },
      { id: "grant_issued", status: "expired" },
      { id: "grant_reserved", status: "reserved" },
    ]);
  });

  it.each([
    ["requested", "approval_invalid"],
    ["reserved", "approval_invalid"],
    ["consumed", "approval_invalid"],
    ["expired", "approval_expired"],
    ["revoked", "approval_invalid"],
    ["invalidated", "approval_invalid"],
  ] as const)("rejects the %s state with %s", async (status, code) => {
    const grants = new FakeGrants();
    grants.records.push({
      id: `grant_${status}`,
      binding: { ...binding, targetHashes: { ["a.html" as RelPath]: hash("1"), ["z.html" as RelPath]: hash("2") } },
      summary: status,
      status,
      approver: status === "requested" ? null : "cli",
      createdAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-08-02T00:05:00.000Z",
    });
    const service = new ApprovalService({
      grants,
      clock: { now: () => new Date("2026-08-02T00:01:00.000Z") },
      ids: { newId: () => "unused" },
    });
    await expect(service.planReserve(`grant_${status}`, binding)).resolves.toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it("does not time out a reserved grant after its issued expiry", async () => {
    const grants = new FakeGrants();
    grants.records.push({
      id: "grant_reserved",
      binding,
      summary: "Reserved",
      status: "reserved",
      approver: "cli",
      createdAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-08-02T00:01:00.000Z",
    });
    const service = new ApprovalService({
      grants,
      clock: { now: () => new Date("2026-08-02T01:00:00.000Z") },
      ids: { newId: () => "unused" },
    });
    await expect(service.planReserve("grant_reserved", binding)).resolves.toMatchObject({
      ok: false,
      error: { code: "approval_invalid" },
    });
    expect(grants.records[0]?.status).toBe("reserved");
  });
});
