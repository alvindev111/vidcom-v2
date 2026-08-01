import {
  Client as ModernClient,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  McpServer as ModernMcpServer,
} from "@modelcontextprotocol/server";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as LegacyInMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server as LegacyServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION as LEGACY_PROTOCOL_VERSION,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

const modernEras: string[] = [];
const modernHandler = createMcpHandler(
  ({ era }) => {
    modernEras.push(era);
    const server = new ModernMcpServer({
      name: "vidcom-modern-spike",
      version: "0.0.0",
    });
    server.registerTool(
      "echo_modern",
      {
        inputSchema: z.object({ message: z.string() }),
        outputSchema: z.object({ echo: z.string() }),
      },
      async ({ message }) => ({
        content: [{ type: "text", text: message }],
        structuredContent: { echo: message },
      }),
    );
    return server;
  },
  { legacy: "reject", responseMode: "json" },
);

const legacyServer = new LegacyServer(
  {
    name: "vidcom-legacy-spike",
    version: "0.0.0",
  },
  { capabilities: { tools: {} } },
);
legacyServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo_legacy",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));
legacyServer.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: String(request.params.arguments?.message ?? ""),
    },
  ],
}));

const [legacyClientTransport, legacyServerTransport] =
  LegacyInMemoryTransport.createLinkedPair();
const modernClientTransport = new StreamableHTTPClientTransport(
  new URL("http://vidcom-spike.local/mcp"),
  {
    fetch: (input, init) => modernHandler.fetch(new Request(input, init)),
  },
);
const modernClient = new ModernClient(
  {
    name: "vidcom-modern-spike-client",
    version: "0.0.0",
  },
  {
    versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
  },
);
const legacyClient = new LegacyClient({
  name: "vidcom-legacy-spike-client",
  version: "0.0.0",
});

await legacyServer.connect(legacyServerTransport);
await Promise.all([
  modernClient.connect(modernClientTransport),
  legacyClient.connect(legacyClientTransport),
]);

const [modernTools, legacyTools, modernCall, legacyCall] = await Promise.all([
  modernClient.listTools(),
  legacyClient.listTools(),
  modernClient.callTool({
    name: "echo_modern",
    arguments: { message: "modern-ok" },
  }),
  legacyClient.callTool({
    name: "echo_legacy",
    arguments: { message: "legacy-ok" },
  }),
]);

console.log(
  JSON.stringify(
    {
      process: process.pid,
      modern: {
        protocolVersion: MODERN_PROTOCOL_VERSION,
        factoryEras: modernEras,
        discovery: modernClient.getDiscoverResult(),
        tools: modernTools.tools.map((tool) => tool.name),
        call: modernCall,
      },
      legacy: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        tools: legacyTools.tools.map((tool) => tool.name),
        call: legacyCall,
      },
    },
    null,
    2,
  ),
);

await Promise.all([
  modernClient.close(),
  legacyClient.close(),
  legacyServer.close(),
  modernHandler.close(),
]);
