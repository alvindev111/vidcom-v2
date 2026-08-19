import { describe, expect, it } from "vitest";

import { createMcpHttpHandlers } from "@vidcom/mcp";

import { createContractMatrixRegistry } from "../support";

const revisions = {
  legacy: "2025-11-25",
  modern: "2026-07-28",
} as const;

function responseMessage(body: string): Record<string, unknown> {
  const serialized = body.startsWith("event:")
    ? body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : body;
  if (!serialized) throw new TypeError("MCP response did not contain a message");
  return JSON.parse(serialized) as Record<string, unknown>;
}

async function toolsListResult(era: keyof typeof revisions): Promise<Record<string, unknown>> {
  const revision = revisions[era];
  const http = createMcpHttpHandlers(createContractMatrixRegistry());
  const handler = http.handlers.get(revision);
  if (!handler) throw new TypeError(`missing ${era} pinned handler`);
  try {
    const response = await handler(new Request("http://vidcom.test/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": revision,
        ...(era === "modern" ? { "Mcp-Method": "tools/list" } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: era === "modern"
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": revision,
                "io.modelcontextprotocol/clientInfo": { name: "golden-test", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            }
          : {},
      }),
    }));
    expect(response.status).toBe(200);
    const message = responseMessage(await response.text());
    if (!message.result || typeof message.result !== "object") {
      throw new TypeError(`missing ${era} tools/list result`);
    }
    return message.result as Record<string, unknown>;
  } finally {
    await http.close();
  }
}

async function toolCallResult(era: keyof typeof revisions): Promise<Record<string, unknown>> {
  const revision = revisions[era];
  const http = createMcpHttpHandlers(createContractMatrixRegistry());
  const handler = http.handlers.get(revision);
  if (!handler) throw new TypeError(`missing ${era} pinned handler`);
  try {
    const response = await handler(new Request("http://vidcom.test/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "MCP-Protocol-Version": revision,
        ...(era === "modern" ? { "Mcp-Method": "tools/call", "Mcp-Name": "list_projects" } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "list_projects",
          arguments: {},
          ...(era === "modern" ? {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": revision,
              "io.modelcontextprotocol/clientInfo": { name: "golden-test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          } : {}),
        },
      }),
    }));
    expect(response.status).toBe(200);
    const message = responseMessage(await response.text());
    if (!message.result || typeof message.result !== "object") {
      throw new TypeError(`missing ${era} tools/call result`);
    }
    return message.result as Record<string, unknown>;
  } finally {
    await http.close();
  }
}

describe.each(["legacy", "modern"] as const)("%s tools/list golden", (era) => {
  it("stays deterministic across repeated SDK-owned responses", async () => {
    const results = await Promise.all([
      toolsListResult(era),
      toolsListResult(era),
      toolsListResult(era),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0].tools).toHaveLength(38);
    for (const tool of results[0].tools as Array<{ description: string }>) {
      expect(tool.description).toContain("Use when");
      expect(tool.description).toContain("Do not use");
      expect(tool.description).toContain("Preconditions:");
      expect(tool.description).toContain("Side effects:");
      expect(tool.description).toContain("Errors/recovery:");
    }
    if (era === "modern") {
      expect(results[0]).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    } else {
      expect(results[0]).not.toHaveProperty("resultType");
      expect(results[0]).not.toHaveProperty("ttlMs");
      expect(results[0]).not.toHaveProperty("cacheScope");
    }
    await expect(`${JSON.stringify(results[0], null, 2)}\n`)
      .toMatchFileSnapshot(`./fixtures/tools-list-${era}.json`);
  });

  it("locks the complete tools/call result shape for its era", async () => {
    const result = await toolCallResult(era);
    if (era === "modern") {
      expect(result).toMatchObject({ resultType: "complete" });
      expect(result).not.toHaveProperty("ttlMs");
      expect(result).not.toHaveProperty("cacheScope");
    } else {
      expect(result).not.toHaveProperty("resultType");
      expect(result).not.toHaveProperty("ttlMs");
      expect(result).not.toHaveProperty("cacheScope");
    }
    await expect(`${JSON.stringify(result, null, 2)}\n`)
      .toMatchFileSnapshot(`./fixtures/result-${era}.json`);
  });
});
