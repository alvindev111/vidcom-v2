import { fileURLToPath } from "node:url";

import { Client as ModernClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { SUPPORTED_REVISIONS } from "@vidcom/contracts";
import { createMcpHttpHandlers, type McpFetchHandler } from "@vidcom/mcp";
import { createTransportRegistry } from "./support";

const stdioFixture = fileURLToPath(new URL("./fixtures/stdio-server.ts", import.meta.url));

function parseResponse(body: string): unknown {
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data?.slice(6) ?? body) as unknown;
}

function post(
  handler: McpFetchHandler,
  body: string,
  protocolVersion?: string,
): Promise<Response> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (protocolVersion) headers.set("MCP-Protocol-Version", protocolVersion);
  return handler(new Request("http://vidcom.test/api/mcp", { method: "POST", headers, body }));
}

async function callModernHttp(handler: McpFetchHandler): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL("http://vidcom.test/api/mcp"), {
    fetch: (input, init) => handler(new Request(input, init)),
  });
  const client = new ModernClient(
    { name: "modern-http-pin-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(transport);
    return (await client.callTool({
      name: "echo_project",
      arguments: { projectId: "canonical-project" },
    })).structuredContent;
  } finally {
    await client.close();
  }
}

describe("revision-pinned MCP HTTP", () => {
  it("builds entry, every exact revision and a moving latest alias", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    try {
      expect([...http.handlers.keys()]).toEqual(["", ...SUPPORTED_REVISIONS, "latest"]);
      expect(http.defaultRevision).toBe(SUPPORTED_REVISIONS[0]);
      expect(http.handlers.get("latest")).toBe(http.handlers.get(SUPPORTED_REVISIONS[0]));
    } finally {
      await http.close();
    }
  });

  it("accepts an exact legacy revision and rejects a same-era mismatch", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const pinned = http.handlers.get("2025-06-18");
    if (!pinned) throw new TypeError("missing pinned handler");
    try {
      const exact = await post(
        pinned,
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        "2025-06-18",
      );
      expect(exact.status).toBe(200);
      expect(parseResponse(await exact.text())).toMatchObject({
        id: 1,
        result: { tools: [{ name: "echo_project" }, { name: "resource_error_probe" }] },
      });

      const mismatch = await post(
        pinned,
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        "2025-11-25",
      );
      expect(mismatch.status).toBe(400);
      expect(parseResponse(await mismatch.text())).toMatchObject({
        id: 2,
        error: {
          code: -32022,
          data: { requested: "2025-11-25", supported: [...SUPPORTED_REVISIONS] },
        },
      });
    } finally {
      await http.close();
    }
  });

  it("preserves the SDK media-type and parse-error ladder before exact-pin comparison", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const entry = http.handlers.get("");
    if (!entry) throw new TypeError("missing entry handler");
    const request = (body: string, requestedRevision: string, contentType?: string) => {
      const headers = new Headers({ accept: "application/json, text/event-stream" });
      headers.set("MCP-Protocol-Version", requestedRevision);
      if (contentType) headers.set("Content-Type", contentType);
      return new Request("http://vidcom.test/api/mcp", {
        method: "POST",
        headers,
        body: new TextEncoder().encode(body),
      });
    };
    const shape = async (response: Response) => ({
      status: response.status,
      message: parseResponse(await response.text()),
    });
    try {
      for (const pinnedRevision of ["2025-06-18", "2026-07-28"]) {
        const pinned = http.handlers.get(pinnedRevision);
        if (!pinned) throw new TypeError(`missing ${pinnedRevision} handler`);
        const mismatchRevision = pinnedRevision === "2026-07-28" ? "2025-11-25" : "2026-07-28";
        for (const requestedRevision of [pinnedRevision, mismatchRevision]) {
          for (const contentType of [undefined, "text/plain"] as const) {
            const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
            const entryShape = await shape(await entry(request(body, requestedRevision, contentType)));
            const pinnedShape = await shape(await pinned(request(body, requestedRevision, contentType)));
            const expected = {
              status: 415,
              message: { id: null, error: { code: -32000 } },
            };
            expect(entryShape).toMatchObject(expected);
            expect(pinnedShape).toMatchObject(expected);
          }

          const entryShape = await shape(await entry(request("{invalid", requestedRevision, "application/json")));
          const pinnedShape = await shape(await pinned(request("{invalid", requestedRevision, "application/json")));
          const expected = {
            status: 400,
            message: { id: null, error: { code: -32700 } },
          };
          expect(entryShape).toMatchObject(expected);
          expect(pinnedShape).toMatchObject(expected);
        }
      }
    } finally {
      await http.close();
    }
  });

  it("rejects an unknown revision with the complete supported list", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const pinned = http.handlers.get("2025-06-18");
    if (!pinned) throw new TypeError("missing pinned handler");
    try {
      const response = await pinned(new Request("http://vidcom.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "MCP-Protocol-Version": "2099-01-01",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 20,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2099-01-01",
              "io.modelcontextprotocol/clientInfo": { name: "unknown-revision-test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }));
      expect(response.status).toBe(400);
      expect(parseResponse(await response.text())).toMatchObject({
        id: 20,
        error: {
          code: -32022,
          data: { requested: "2099-01-01", supported: [...SUPPORTED_REVISIONS] },
        },
      });
    } finally {
      await http.close();
    }
  });

  it("uses the SDK default for legacy batches and the initialize body revision", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const defaultPinned = http.handlers.get("2025-03-26");
    const bodyPinned = http.handlers.get("2025-06-18");
    if (!defaultPinned || !bodyPinned) throw new TypeError("missing legacy pinned handlers");
    try {
      const batch = await post(defaultPinned, JSON.stringify([
        { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
      ]));
      expect(batch.status).toBe(200);
      const batchBody = await batch.text();
      expect(batchBody).toContain('"id":10');
      expect(batchBody).toContain('"id":11');

      const initialize = await post(bodyPinned, JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "revision-pin-test", version: "1.0.0" },
        },
      }), "2025-11-25");
      expect(initialize.status).toBe(200);
      expect(parseResponse(await initialize.text())).toMatchObject({
        id: 12,
        result: { protocolVersion: "2025-06-18" },
      });
    } finally {
      await http.close();
    }
  });

  it("pins stdio through the server factory allowlist", async () => {
    const modernTransport = new ModernStdio({
      command: "bun",
      args: ["run", stdioFixture, "2026-07-28"],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const modern = new ModernClient(
      { name: "modern-pin-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await modern.connect(modernTransport);
    expect(modern.getProtocolEra()).toBe("modern");
    expect((await modern.callTool({
      name: "echo_project",
      arguments: { projectId: "canonical-project" },
    })).structuredContent).toEqual({ projectId: "canonical-project" });
    await modern.close();
    expect(modernTransport.pid).toBeNull();

    const legacyTransport = new LegacyStdio({
      command: "bun",
      args: ["run", stdioFixture, "2026-07-28"],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const legacy = new LegacyClient({ name: "legacy-mismatch-test", version: "1.0.0" });
    await expect(legacy.connect(legacyTransport)).rejects.toMatchObject({ code: -32022 });
    await legacy.close();
    expect(legacyTransport.pid).toBeNull();
  });

  it("returns one canonical result through entry, exact modern and latest", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const entry = http.handlers.get("");
    const pinned = http.handlers.get("2026-07-28");
    const latest = http.handlers.get("latest");
    if (!entry || !pinned || !latest) throw new TypeError("missing modern HTTP handlers");
    try {
      const results = await Promise.all([
        callModernHttp(entry),
        callModernHttp(pinned),
        callModernHttp(latest),
      ]);
      expect(results).toEqual([
        { projectId: "canonical-project" },
        { projectId: "canonical-project" },
        { projectId: "canonical-project" },
      ]);
    } finally {
      await http.close();
    }
  });
});
