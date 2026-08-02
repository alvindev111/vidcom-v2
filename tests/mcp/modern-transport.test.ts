import { fileURLToPath } from "node:url";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

import { createMcpHttpHandlers, MCP_SERVER_INFO } from "@vidcom/mcp";
import { createTransportRegistry } from "./support";

const MODERN_REVISION = "2026-07-28";
const fixture = fileURLToPath(new URL("./fixtures/stdio-server.ts", import.meta.url));
const approvalArguments = {
  projectId: "project-modern",
  path: "src/probe.ts",
  expectedContentHash: `sha256:${"0".repeat(64)}`,
};

function modernClient(): Client {
  const client = new Client(
    { name: "vidcom-modern-test", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: MODERN_REVISION } },
    },
  );
  client.setRequestHandler("elicitation/create", async () => ({
    action: "accept",
    content: { grantId: "grant-modern" },
  }));
  return client;
}

function responseMessages(body: string): Record<string, unknown>[] {
  const candidates = body.startsWith("event:")
    ? body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6))
    : [body];
  return candidates.map((candidate) => JSON.parse(candidate) as Record<string, unknown>);
}

describe("modern MCP transport", () => {
  it("serves discover and MRTR over stdio with protocol-only stdout", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", fixture],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const stderr: Buffer[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const client = modernClient();

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getDiscoverResult()).toMatchObject({
        _meta: { "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO },
        supportedVersions: [MODERN_REVISION],
      });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "approval_probe",
        "echo_project",
        "resource_error_probe",
      ]);
      const approved = await client.callTool({ name: "approval_probe", arguments: approvalArguments });
      expect(approved.structuredContent).toEqual({ projectId: "project-modern" });
    } finally {
      await client.close();
    }

    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(transport.pid).toBeNull();
  });

  it("stamps modern HTTP results, uses private cache and rejects header mismatch", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const entry = http.handlers.get("");
    if (!entry) throw new TypeError("missing default MCP entry handler");
    const exchanges: Array<{ request: Request; body: string; responseBody: string }> = [];
    const transport = new StreamableHTTPClientTransport(new URL("http://vidcom.test/api/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request.clone().text();
        const response = await entry(request);
        exchanges.push({ request: new Request(input, init), body, responseBody: await response.clone().text() });
        return response;
      },
    });
    const client = modernClient();

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "approval_probe",
        "echo_project",
        "resource_error_probe",
      ]);
      const approved = await client.callTool({ name: "approval_probe", arguments: approvalArguments });
      expect(approved.structuredContent).toEqual({ projectId: "project-modern" });
      const missing = await client.callTool({
        name: "resource_error_probe",
        arguments: { projectId: "project-missing" },
      });
      expect(missing.isError).toBe(true);
      const missingText = missing.content.find((item) => item.type === "text")?.text;
      expect(JSON.parse(missingText ?? "null")).toMatchObject({
        code: -32602,
        data: { error: { code: "no_file" } },
      });

      const wireMessages = exchanges.flatMap((exchange) => responseMessages(exchange.responseBody));
      const listResult = wireMessages
        .map((message) => message.result as Record<string, unknown> | undefined)
        .find((result) => Array.isArray(result?.tools));
      expect(listResult).toMatchObject({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
      });
      expect(wireMessages.some((message) =>
        (message.result as Record<string, unknown> | undefined)?.resultType === "input_required"
        && (message.result as Record<string, unknown>).requestState === "approval-request-1")).toBe(true);
      expect(wireMessages.some((message) => {
        const result = message.result as Record<string, unknown> | undefined;
        return result?.resultType === "complete"
          && (result.structuredContent as Record<string, unknown> | undefined)?.projectId === "project-modern";
      })).toBe(true);

      const listExchange = exchanges.find((exchange) => {
        try { return (JSON.parse(exchange.body) as { method?: string }).method === "tools/list"; }
        catch { return false; }
      });
      if (!listExchange) throw new TypeError("modern tools/list request was not captured");
      const headers = new Headers(listExchange.request.headers);
      headers.set("Mcp-Method", "tools/call");
      const mismatch = await entry(new Request(listExchange.request.url, {
        method: "POST",
        headers,
        body: listExchange.body,
      }));
      const mismatchMessages = responseMessages(await mismatch.text());
      expect(mismatchMessages[0]).toMatchObject({ error: { code: -32020 } });
    } finally {
      await client.close();
      await http.close();
    }
  });
});
