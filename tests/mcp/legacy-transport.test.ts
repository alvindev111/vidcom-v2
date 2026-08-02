import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createMcpHttpHandlers, MCP_SERVER_INFO } from "@vidcom/mcp";
import { createTransportRegistry } from "./support";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.ts", import.meta.url));

describe("legacy stdio transport", () => {
  it("negotiates SDK 1.30, serves the shared Registry and closes cleanly", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", fixture],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const stderr: Buffer[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const client = new Client({ name: "vidcom-legacy-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
      expect(client.getServerVersion()).toEqual(MCP_SERVER_INFO);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["echo_project", "resource_error_probe"]);
      expect(listed).not.toHaveProperty("resultType");
      expect(listed).not.toHaveProperty("ttlMs");
      expect(listed).not.toHaveProperty("cacheScope");

      const called = await client.callTool({
        name: "echo_project",
        arguments: { projectId: "project-legacy" },
      });
      expect(called.structuredContent).toEqual({ projectId: "project-legacy" });
      expect(called).not.toHaveProperty("resultType");
      expect(called).not.toHaveProperty("ttlMs");
      expect(called).not.toHaveProperty("cacheScope");
      const missing = await client.callTool({
        name: "resource_error_probe",
        arguments: { projectId: "project-missing" },
      });
      expect(missing.isError).toBe(true);
      const missingText = (missing as { content?: Array<{ type: string; text?: string }> })
        .content?.find((item) => item.type === "text")?.text;
      expect(JSON.parse(missingText ?? "null")).toMatchObject({
        code: -32002,
        data: { error: { code: "no_file" } },
      });
    } finally {
      await client.close();
    }

    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(transport.pid).toBeNull();
  });

  it("serves legacy HTTP statelessly and rejects session methods", async () => {
    const http = createMcpHttpHandlers(createTransportRegistry());
    const entry = http.handlers.get("");
    if (!entry) throw new TypeError("missing default MCP entry handler");
    const transport = new StreamableHTTPClientTransport(new URL("http://vidcom.test/api/mcp"), {
      fetch: (input, init) => entry(new Request(input, init)),
    });
    const client = new Client({ name: "vidcom-legacy-http-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["echo_project", "resource_error_probe"]);
      const called = await client.callTool({
        name: "echo_project",
        arguments: { projectId: "project-http" },
      });
      expect(called.content).toContainEqual({
        type: "text",
        text: JSON.stringify({ projectId: "project-http" }),
      });

      const noVersion = await entry(new Request("http://vidcom.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
      }));
      expect(noVersion.status).toBe(200);
      const noVersionBody = await noVersion.text();
      const dataLine = noVersionBody.split("\n").find((line) => line.startsWith("data: "));
      const noVersionMessage = JSON.parse(dataLine?.slice(6) ?? noVersionBody) as unknown;
      expect(noVersionMessage).toMatchObject({
        jsonrpc: "2.0",
        id: 99,
        result: { tools: [{ name: "echo_project" }, { name: "resource_error_probe" }] },
      });

      for (const method of ["GET", "DELETE"]) {
        const response = await entry(new Request("http://vidcom.test/api/mcp", { method }));
        expect(response.status).toBe(405);
        expect(await response.text()).toContain("Method not allowed.");
      }
    } finally {
      await client.close();
      await http.close();
    }
  });
});
