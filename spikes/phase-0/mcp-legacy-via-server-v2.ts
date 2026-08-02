/**
 * Spike Q10 — can `@modelcontextprotocol/server@2.0.0` serve BOTH protocol
 * generations over HTTP on its own, without `@modelcontextprotocol/sdk@1.x`?
 *
 * Spike 0.3 proved the two SDK generations can coexist in one process, but it
 * served legacy with the 1.x low-level `Server` over an in-memory transport.
 * That left open whether the 2.x handler alone covers legacy HTTP traffic — if
 * it does, half of the planned dual stack disappears.
 *
 * The server side of this file imports ONLY `@modelcontextprotocol/server`.
 * `sdk@1.x` appears solely as the legacy *client*, standing in for a real
 * legacy host such as Claude Code 2.1.207.
 */
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION as LEGACY_LATEST } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const MODERN_REVISION = "2026-07-28";

/** Every era the handler factory was invoked with, in call order. */
const observedEras: string[] = [];

/**
 * One factory, one tool, both generations. `legacy` is deliberately omitted so
 * the spike exercises the documented default (`'stateless'`).
 */
const handler = createMcpHandler(({ era }) => {
  observedEras.push(era);
  const server = new McpServer({ name: "vidcom-q10", version: "0.0.0" });
  server.registerTool(
    "echo",
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
}, { responseMode: "json" });

/** Raw JSON-RPC responses, captured so era-specific fields can be asserted. */
const rawByEra: Record<string, unknown[]> = { legacy: [], modern: [] };

const listener = Bun.serve({
  port: 0,
  idleTimeout: 30,
  fetch: async (request) => {
    const era = request.headers.get("x-spike-era") ?? "unknown";
    const response = await handler.fetch(request);
    // Tee the body so the assertions below can read it without consuming the
    // stream the transport is about to parse.
    const [forClient, forSpike] = response.body ? response.body.tee() : [null, null];
    if (forSpike) {
      const text = await new Response(forSpike).text();
      const payload = text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
      rawByEra[era]?.push(payload);
    }
    return new Response(forClient, {
      status: response.status,
      headers: response.headers,
    });
  },
});

const endpoint = `http://127.0.0.1:${listener.port}/mcp`;

/** Marks each request so the tee above can bucket the response by era. */
const taggedFetch = (era: string) => (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input as never, init);
  request.headers.set("x-spike-era", era);
  return fetch(request);
};

const legacyClient = new LegacyClient({ name: "q10-legacy-client", version: "0.0.0" });
const modernClient = new ModernClient(
  { name: "q10-modern-client", version: "0.0.0" },
  { versionNegotiation: { mode: { pin: MODERN_REVISION } } },
);

await legacyClient.connect(
  new LegacyTransport(new URL(endpoint), { fetch: taggedFetch("legacy") as never }),
);
await modernClient.connect(
  new ModernTransport(new URL(endpoint), { fetch: taggedFetch("modern") as never }),
);

const [legacyTools, modernTools, legacyCall, modernCall] = await Promise.all([
  legacyClient.listTools(),
  modernClient.listTools(),
  legacyClient.callTool({ name: "echo", arguments: { message: "legacy-ok" } }),
  modernClient.callTool({ name: "echo", arguments: { message: "modern-ok" } }),
]);

/** 2025 session operations are documented as unsupported in stateless mode. */
const getProbe = await fetch(endpoint, { method: "GET" });

/** Pulls the `result` object out of every captured JSON-RPC response. */
const resultsFor = (era: string) =>
  rawByEra[era]
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .map((entry) => (entry as { result?: Record<string, unknown> })?.result)
    .filter((value): value is Record<string, unknown> => Boolean(value));

const fieldPresence = (era: string, field: string) =>
  resultsFor(era).some((result) => field in result);

console.log(
  JSON.stringify(
    {
      question: "Q10 — does server@2 alone serve legacy over HTTP?",
      pid: process.pid,
      legacyMode: "default (option omitted)",
      observedEras: [...new Set(observedEras)],
      legacy: {
        clientSdk: "@modelcontextprotocol/sdk@1.x",
        negotiatedLatest: LEGACY_LATEST,
        serverReported: legacyClient.getServerVersion(),
        tools: legacyTools.tools.map((tool) => tool.name),
        callText: (legacyCall as { content?: { text?: string }[] }).content?.[0]?.text,
        hasResultType: fieldPresence("legacy", "resultType"),
        hasTtlMs: fieldPresence("legacy", "ttlMs"),
        hasCacheScope: fieldPresence("legacy", "cacheScope"),
      },
      modern: {
        clientSdk: "@modelcontextprotocol/client@2.x",
        pinnedRevision: MODERN_REVISION,
        discover: modernClient.getDiscoverResult(),
        tools: modernTools.tools.map((tool) => tool.name),
        callText: (modernCall as { content?: { text?: string }[] }).content?.[0]?.text,
        hasResultType: fieldPresence("modern", "resultType"),
        hasTtlMs: fieldPresence("modern", "ttlMs"),
        hasCacheScope: fieldPresence("modern", "cacheScope"),
      },
      sessionOps: { getStatus: getProbe.status },
    },
    null,
    2,
  ),
);

await Promise.all([legacyClient.close(), modernClient.close()]);
await handler.close();
listener.stop(true);
