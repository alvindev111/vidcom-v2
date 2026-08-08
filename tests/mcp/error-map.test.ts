import { describe, expect, it } from "vitest";

import { ErrorCode, MCP_PUBLIC_ERROR_CODES, type DomainError } from "@vidcom/contracts";
import {
  mapMcpError,
  MCP_INTERNAL_ERROR,
  MCP_INVALID_PARAMS,
  MCP_LEGACY_RESOURCE_NOT_FOUND,
  mcpToolError,
} from "@vidcom/mcp";

function error(code: ErrorCode, details?: Record<string, unknown>): DomainError {
  return { code, message: `${code} message`, ...(details ? { details } : {}) };
}

describe("MCP domain error mapping", () => {
  it("maps resource misses by era", () => {
    for (const code of [ErrorCode.ProjectNotFound, ErrorCode.NotFound, ErrorCode.NoFile]) {
      expect(mapMcpError(error(code), "legacy").code).toBe(MCP_LEGACY_RESOURCE_NOT_FOUND);
      expect(mapMcpError(error(code), "modern").code).toBe(MCP_INVALID_PARAMS);
    }
  });

  it("preserves conflict, approval and recovery detail without blind-retry advice", () => {
    const current = { fileHashes: { "src/a.ts": "sha256:abc" }, projectRevision: 7 };
    expect(mapMcpError(error(ErrorCode.WriteConflict, { current }), "modern")).toMatchObject({
      code: MCP_INVALID_PARAMS,
      data: { error: { details: { current } }, retryable: false },
    });
    expect(mapMcpError(error(ErrorCode.ApprovalRequired, { requestId: "approval-1" }), "legacy"))
      .toMatchObject({ code: MCP_INVALID_PARAMS, data: { error: { details: { requestId: "approval-1" } } } });
    expect(mapMcpError(error(ErrorCode.RecoveryRequired, { journalId: 42, phase: "t2" }), "modern"))
      .toMatchObject({
        code: MCP_INTERNAL_ERROR,
        data: {
          retryable: false,
          error: { details: { journalId: 42, phase: "t2" } },
          guidance: expect.stringContaining("resolve"),
        },
      });
    expect(mapMcpError(error(ErrorCode.CommittedResponseError, {
      committed: true,
      projectRevision: 7,
    }), "modern")).toMatchObject({
      code: MCP_INTERNAL_ERROR,
      data: {
        retryable: false,
        error: { details: { committed: true, projectRevision: 7 } },
        guidance: expect.stringMatching(/already committed.*Do not retry/i),
      },
    });
  });

  it("covers every domain code and emits one canonical tool-error shape", () => {
    const publicCodes = new Set<ErrorCode>(MCP_PUBLIC_ERROR_CODES);
    for (const code of Object.values(ErrorCode)) {
      const mapped = mapMcpError(error(code), "modern");
      expect([-32602, -32603]).toContain(mapped.code);
      expect(mapped.data.error.code).toBe(publicCodes.has(code) ? code : ErrorCode.Internal);
    }
    const toolError = mcpToolError(error(ErrorCode.TimingInvalid), "modern");
    expect(toolError).toMatchObject({
      isError: true,
      _meta: { "io.vidcom/error": { code: MCP_INVALID_PARAMS } },
    });
    expect(JSON.parse(toolError.content[0].text)).toMatchObject({
      code: MCP_INVALID_PARAMS,
      data: { error: { code: ErrorCode.TimingInvalid } },
    });
  });

  it("redacts every packaging-only code from public MCP error payloads", () => {
    const publicCodes = new Set<ErrorCode>(MCP_PUBLIC_ERROR_CODES);
    const privateCodes = Object.values(ErrorCode).filter((code) => !publicCodes.has(code));
    // 15 since download_unavailable joined: Design §5.18 requires it and Phase A
    // shipped only download_tls_untrusted. It stays private, like every other
    // packaging-only code.
    expect(privateCodes).toHaveLength(19);

    for (const code of privateCodes) {
      const toolError = mcpToolError(error(code, { originalCode: code }), "modern");
      const serialized = JSON.stringify(toolError);
      expect(toolError._meta["io.vidcom/error"].data.error).toEqual({
        code: ErrorCode.Internal,
        message: "tool failed outside the published MCP error contract",
      });
      expect(serialized).not.toContain(code);
    }
  });
});
