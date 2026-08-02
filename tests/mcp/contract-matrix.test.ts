import { fileURLToPath } from "node:url";

import { Client as ModernClient, StreamableHTTPClientTransport as ModernHttp } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { createMcpHttpHandlers } from "@vidcom/mcp";

import { CONTRACT_MATRIX_CASES, createContractMatrixRegistry } from "./support";

const fixture = fileURLToPath(new URL("./fixtures/contract-matrix-server.ts", import.meta.url));
const modernRevision = "2026-07-28";
const legacyRevision = "2025-11-25";
const expectedTools = Object.keys(CONTRACT_MATRIX_CASES).sort();

async function exercise(client: LegacyClient | ModernClient): Promise<void> {
  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual(expectedTools);
  for (const [name, arguments_] of Object.entries(CONTRACT_MATRIX_CASES)) {
    const result = await client.callTool({ name, arguments: arguments_ });
    if (name === "list_projects") {
      expect((result as { structuredContent?: unknown }).structuredContent).toEqual({ projects: [] });
    } else {
      expect((result as { isError?: boolean }).isError, name).toBe(true);
    }
  }
}

function modernClient(name: string): ModernClient {
  return new ModernClient(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: modernRevision } } },
  );
}

describe("2 era x 2 transport production-tool contract matrix", () => {
  it("runs all tools with sdk@1.30.0 over stdio", async () => {
    const transport = new LegacyStdio({
      command: "bun",
      args: ["run", fixture, legacyRevision],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new LegacyClient({ name: "matrix-legacy-stdio", version: "1.0.0" });
    try {
      await client.connect(transport);
      await exercise(client);
    } finally {
      await client.close();
    }
    expect(transport.pid).toBeNull();
  });

  it("runs all tools with client@2.0.0 over stdio", async () => {
    const transport = new ModernStdio({
      command: "bun",
      args: ["run", fixture, modernRevision],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = modernClient("matrix-modern-stdio");
    try {
      await client.connect(transport);
      await exercise(client);
    } finally {
      await client.close();
    }
    expect(transport.pid).toBeNull();
  });

  it("runs all tools with sdk@1.30.0 over HTTP", async () => {
    const http = createMcpHttpHandlers(createContractMatrixRegistry());
    const handler = http.handlers.get(legacyRevision);
    if (!handler) throw new Error("missing legacy handler");
    const client = new LegacyClient({ name: "matrix-legacy-http", version: "1.0.0" });
    try {
      await client.connect(new LegacyHttp(new URL("http://vidcom.test/api/mcp"), {
        fetch: (input, init) => handler(new Request(input, init)),
      }));
      await exercise(client);
    } finally {
      await client.close();
      await http.close();
    }
  });

  it("runs all tools with client@2.0.0 over HTTP", async () => {
    const http = createMcpHttpHandlers(createContractMatrixRegistry());
    const handler = http.handlers.get(modernRevision);
    if (!handler) throw new Error("missing modern handler");
    const client = modernClient("matrix-modern-http");
    try {
      await client.connect(new ModernHttp(new URL("http://vidcom.test/api/mcp"), {
        fetch: (input, init) => handler(new Request(input, init)),
      }));
      await exercise(client);
    } finally {
      await client.close();
      await http.close();
    }
  });
});
