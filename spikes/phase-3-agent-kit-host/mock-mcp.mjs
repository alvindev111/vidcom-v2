#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "vidcom-host-spike", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "vidcom_probe",
    description: "Record one agent-kit host-discovery probe.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string" },
        linkToken: { type: "string" },
      },
      required: ["caseId"],
      additionalProperties: false,
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "vidcom_probe") {
    return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
  }
  const { caseId, linkToken } = request.params.arguments ?? {};
  if (typeof caseId !== "string" || (linkToken !== undefined && typeof linkToken !== "string")) {
    return { isError: true, content: [{ type: "text", text: "Invalid probe input" }] };
  }
  const record = { caseId, linkToken: linkToken ?? null };
  if (process.env.VIDCOM_PROBE_LOG) {
    appendFileSync(process.env.VIDCOM_PROBE_LOG, `${JSON.stringify(record)}\n`, "utf8");
  }
  return {
    content: [{ type: "text", text: `VIDCOM_PROBE_OK ${caseId}` }],
    structuredContent: record,
  };
});

await server.connect(new StdioServerTransport());
