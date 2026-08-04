import { describe, expect, it } from "vitest";

import { ErrorCode, SUPPORTED_REVISIONS, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ApprovalService,
  err,
  ToolAuditService,
  type AbsolutePath,
  type ApprovalGrantPort,
  type ApprovalGrantRecord,
  type GrantBinding,
  type ProjectRef,
} from "@vidcom/core";
import {
  createMcpHttpHandlers,
  mapMcpError,
  saveFileTool,
  ToolRegistry,
  type WriteToolDependencies,
} from "@vidcom/mcp";

import { createTransportRegistry } from "./support";

const projectId = "project-negative-contract" as ProjectId;
const hash = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;
const binding: GrantBinding = {
  tool: "delete_file",
  projectId,
  target: "unused.html",
  expectedRevision: 0,
  planDigest: hash("a"),
  targetHashes: { ["unused.html" as RelPath]: hash("1") },
};

function audit(): ToolAuditService {
  return new ToolAuditService(
    { record: async () => undefined },
    { now: () => new Date("2026-08-02T00:00:00.000Z") },
    { warn: () => undefined, error: () => undefined },
    { increment: () => undefined, observeMilliseconds: () => undefined },
    { isJournalOwned: async () => false },
  );
}

class Grants implements ApprovalGrantPort {
  readonly records = new Map<string, ApprovalGrantRecord>();
  async create(record: ApprovalGrantRecord) { this.records.set(record.id, record); }
  async read(id: string) { return this.records.get(id) ?? null; }
  async issue(id: string, approver: "ui" | "cli", _issuedAt: string, expiresAt: string) {
    const record = this.records.get(id);
    if (!record || record.status !== "requested") return null;
    Object.assign(record, { status: "issued", approver, expiresAt });
    return record;
  }
  async revoke(id: string) {
    const record = this.records.get(id);
    if (!record || record.status !== "issued") return false;
    record.status = "revoked";
    return true;
  }
  async matches(id: string, expected: GrantBinding, now: string) {
    const record = this.records.get(id);
    return Boolean(record?.status === "issued" && record.expiresAt > now
      && JSON.stringify(record.binding) === JSON.stringify(expected));
  }
  async expireDue() { return 0; }
  async cleanupTerminal() { return 0; }
}

function requestContext(era: "legacy" | "modern") {
  return {
    era,
    protocolVersion: era === "legacy" ? "2025-11-25" : "2026-07-28",
    credentialId: null,
    requestInput: async (): Promise<never> => { throw new Error("input not expected"); },
  };
}

function parseResponse(body: string): Record<string, unknown> {
  const serialized = body.startsWith("event:")
    ? body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : body;
  return JSON.parse(serialized ?? "null") as Record<string, unknown>;
}

describe("negative MCP contract matrix", () => {
  it("rejects missing and stale write preconditions before any success is reported", async () => {
    const ref: ProjectRef = {
      id: projectId,
      slug: "negative-contract",
      root: "/workspace/negative-contract" as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const registry = new ToolRegistry({ audit: audit(), approvals: { request: async () => "unused" } });
    registry.register(saveFileTool({
      workspace: { readProjectRef: async () => ref },
      authority: {
        mutateSource: async () => err({
          code: ErrorCode.WriteConflict,
          message: "the project changed since it was read",
          field: "expectedContentHash",
        }),
      },
      composition: {},
      journal: {},
      clock: { now: () => new Date() },
    } as unknown as WriteToolDependencies));

    await expect(registry.invoke("save_file", {
      projectId,
      path: "compositions/scene.html",
      content: "<main />",
    }, requestContext("modern"))).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.SchemaInvalid },
    });
    await expect(registry.invoke("save_file", {
      projectId,
      path: "compositions/scene.html",
      content: "<main />",
      expectedContentHash: hash("0"),
    }, requestContext("modern"))).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.WriteConflict, field: "expectedContentHash" },
    });
  });

  it("uniformly rejects missing, replayed and expired grants", async () => {
    let now = new Date("2026-08-02T00:00:00.000Z");
    let nextGrantId = 0;
    const grants = new Grants();
    const service = new ApprovalService({
      grants,
      clock: { now: () => now },
      ids: { newId: () => `grant-negative-${++nextGrantId}` },
    });
    await expect(service.planReserve("missing", binding)).resolves.toMatchObject({
      ok: false, error: { code: ErrorCode.ApprovalInvalid },
    });
    const id = await service.request(binding, "Delete unused file");
    await expect(service.issue(id, "cli")).resolves.toMatchObject({ ok: true });
    await expect(service.planReserve(id, binding)).resolves.toMatchObject({ ok: true });
    grants.records.get(id)!.status = "consumed";
    await expect(service.planReserve(id, binding)).resolves.toMatchObject({
      ok: false, error: { code: ErrorCode.ApprovalInvalid },
    });

    const expired = await service.request(binding, "Expired request");
    await expect(service.issue(expired, "cli")).resolves.toMatchObject({ ok: true });
    now = new Date("2026-08-02T00:05:00.000Z");
    await expect(service.planReserve(expired, binding)).resolves.toMatchObject({
      ok: false, error: { code: ErrorCode.ApprovalExpired },
    });
  });

  it("rejects unknown revisions and preserves the no-header legacy default", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const pinned = http.handlers.get("2025-03-26");
    if (!pinned) throw new TypeError("missing default legacy handler");
    try {
      const unknown = await pinned(new Request("http://vidcom.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "MCP-Protocol-Version": "2099-01-01",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2099-01-01",
              "io.modelcontextprotocol/clientInfo": { name: "negative-matrix", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }));
      expect(unknown.status).toBe(400);
      expect(parseResponse(await unknown.text())).toMatchObject({
        error: { code: -32022, data: { supported: [...SUPPORTED_REVISIONS] } },
      });

      const fallback = await pinned(new Request("http://vidcom.test/api/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }));
      expect(fallback.status).toBe(200);
      expect(parseResponse(await fallback.text())).toMatchObject({ result: { tools: expect.any(Array) } });
    } finally {
      await http.close();
    }
  });

  it("splits resource codes by era and hides a modern-only tool from legacy", async () => {
    const resource = { code: ErrorCode.NoFile, message: "missing" };
    expect(mapMcpError(resource, "legacy").code).toBe(-32002);
    expect(mapMcpError(resource, "modern").code).toBe(-32602);

    const registry = createTransportRegistry();
    expect(registry.list("legacy").map((tool) => tool.name)).not.toContain("approval_probe");
    await expect(registry.invoke("approval_probe", {
      projectId,
      path: "unused.html",
      expectedContentHash: hash("1"),
    }, requestContext("legacy"))).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.ToolNotAvailableInEra },
    });
  });
});
