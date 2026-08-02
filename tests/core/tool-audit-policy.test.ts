import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import type { PendingToolAudit } from "@vidcom/core";
import {
  AUDIT_ABSOLUTE_PATH_REDACTED,
  AUDIT_REDACTED,
  normalizePendingToolAudit,
  parsePendingToolAudit,
  redactAuditDetail,
  serializePendingToolAudit,
  ToolAuditService,
} from "@vidcom/core";
import type { ToolAuditEntry } from "@vidcom/core";

const pending = (detail: Record<string, unknown> = {}): PendingToolAudit => ({
  schemaVersion: 1,
  invocationId: "invoke-1",
  tool: "save_file",
  level: "write",
  projectId: "project-1" as PendingToolAudit["projectId"],
  era: "modern",
  protocolVersion: "2025-06-18",
  detail,
  credentialId: "credential-1",
  invokedAt: "2026-08-02T00:00:00.000Z",
});

describe("tool audit redaction and serialization", () => {
  it("redacts secrets and raw authored content recursively while retaining non-secret identifiers", () => {
    expect(redactAuditDetail({
      token: "top-secret",
      credentialId: "credential-1",
      input: { fileContent: "raw source", api_key: "key", grantId: "grant-1" },
      values: [{ script: "voiceover" }],
    })).toEqual({
      credentialId: "credential-1",
      input: { api_key: AUDIT_REDACTED, fileContent: AUDIT_REDACTED, grantId: "grant-1" },
      token: AUDIT_REDACTED,
      values: [{ script: AUDIT_REDACTED }],
    });
  });

  it.each(["/Users/person/project/index.html", "C:\\Users\\person\\file.txt", "\\\\server\\share\\file"])(
    "redacts absolute path %s without hiding project-relative paths",
    (absolutePath) => {
      expect(redactAuditDetail({ absolutePath, relativePath: "compositions/scene-1.html" })).toEqual({
        absolutePath: AUDIT_ABSOLUTE_PATH_REDACTED,
        relativePath: "compositions/scene-1.html",
      });
    },
  );

  it("serializes canonically, validates schema v1 and reapplies redaction", () => {
    const first = serializePendingToolAudit(pending({ z: 1, content: "private", a: { y: 2, x: 1 } }));
    const second = serializePendingToolAudit(pending({ a: { x: 1, y: 2 }, content: "different", z: 1 }));

    expect(first).toBe(second);
    expect(parsePendingToolAudit(first)).toEqual(pending({ a: { x: 1, y: 2 }, content: AUDIT_REDACTED, z: 1 }));
  });

  it("rejects unknown schema versions and non-JSON detail", () => {
    expect(() => normalizePendingToolAudit({ ...pending(), schemaVersion: 2 })).toThrow("schema version");
    expect(() => serializePendingToolAudit(pending({ value: Number.NaN }))).toThrow("finite");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializePendingToolAudit(pending(circular))).toThrow("circular");
  });
});

const terminal = (outcome: "ok" | "error" = "ok"): ToolAuditEntry => ({
  tool: "list_projects",
  level: "read",
  projectId: null,
  era: "modern",
  protocolVersion: "2025-06-18",
  outcome,
  errorCode: outcome === "error" ? ErrorCode.Internal : null,
  detail: { token: "private", count: 2 },
  credentialId: "credential-1",
});

describe("ToolAuditService", () => {
  it("prepares one schema-versioned redacted write context", () => {
    const service = new ToolAuditService(
      { record: async () => undefined },
      { now: () => new Date("2026-08-02T00:00:00.000Z") },
      { warn: () => undefined, error: () => undefined },
      { increment: () => undefined, observeMilliseconds: () => undefined },
      { isJournalOwned: async () => false },
    );

    expect(service.prepareWrite({
      ...terminal(),
      tool: "save_file",
      level: "write",
      projectId: "project-1" as PendingToolAudit["projectId"],
      invocationId: "invoke-1",
      invokedAt: "2026-08-02T00:00:00.000Z",
    })).toEqual(pending({ count: 2, token: AUDIT_REDACTED }));
  });

  it("retries a read exactly once and succeeds without escalation", async () => {
    let calls = 0;
    const metrics: string[] = [];
    const warnings: string[] = [];
    const service = new ToolAuditService(
      { record: async () => { calls += 1; if (calls === 1) throw new Error("temporary"); } },
      { now: () => new Date("2026-08-02T00:00:00.000Z") },
      { warn: (message) => warnings.push(message), error: () => undefined },
      { increment: (name) => metrics.push(name), observeMilliseconds: () => undefined },
      { isJournalOwned: async () => false },
    );

    await expect(service.recordRead(terminal())).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(warnings).toEqual([]);
    expect(metrics).toEqual(["audit_record_retry_success"]);
  });

  it.each([
    ["read", "warn"],
    ["failure", "error"],
  ] as const)("fails open for %s and escalates after the second repository failure", async (kind, logLevel) => {
    let calls = 0;
    const logs: string[] = [];
    const metrics: string[] = [];
    const service = new ToolAuditService(
      { record: async () => { calls += 1; throw new Error("unavailable"); } },
      { now: () => new Date("2026-08-02T00:00:00.000Z") },
      { warn: () => logs.push("warn"), error: () => logs.push("error") },
      { increment: (name) => metrics.push(name), observeMilliseconds: () => undefined },
      { isJournalOwned: async () => false },
    );

    if (kind === "read") await service.recordRead(terminal());
    else await service.recordFailure(terminal("error"));

    expect(calls).toBe(2);
    expect(logs).toEqual([logLevel]);
    expect(metrics).toEqual(["audit_record_failure"]);
  });

  it("does not record a guessed failure when ownership lookup is unknown", async () => {
    let records = 0;
    const logs: string[] = [];
    const metrics: string[] = [];
    const service = new ToolAuditService(
      { record: async () => { records += 1; } },
      { now: () => new Date("2026-08-02T00:00:00.000Z") },
      { warn: () => undefined, error: (message) => logs.push(message) },
      { increment: (name) => metrics.push(name), observeMilliseconds: () => undefined },
      { isJournalOwned: async () => { throw new Error("database unavailable"); } },
    );

    await expect(service.recordFailureIfCallerOwned("invoke-1", terminal("error"))).resolves.toBe("unknown");
    expect(records).toBe(0);
    expect(logs).toEqual(["tool audit ownership lookup failed"]);
    expect(metrics).toEqual(["audit_ownership_unknown"]);
  });

  it.each([
    [true, "journal_owned", 0],
    [false, "caller_recorded", 1],
  ] as const)("routes ownership=%s without duplicate terminal rows", async (owned, outcome, expectedRecords) => {
    let records = 0;
    const service = new ToolAuditService(
      { record: async () => { records += 1; } },
      { now: () => new Date("2026-08-02T00:00:00.000Z") },
      { warn: () => undefined, error: () => undefined },
      { increment: () => undefined, observeMilliseconds: () => undefined },
      { isJournalOwned: async (invocationId) => invocationId === "invoke-1" && owned },
    );

    await expect(service.recordFailureIfCallerOwned("invoke-1", terminal("error"))).resolves.toBe(outcome);
    expect(records).toBe(expectedRecords);
  });
});
