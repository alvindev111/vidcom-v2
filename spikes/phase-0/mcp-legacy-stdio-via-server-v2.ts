/**
 * Spike Q10, stdio half — the case that actually decides the architecture.
 *
 * Claude Code 2.1.207 is legacy-only (max `2025-11-25`) AND spawns MCP servers
 * over stdio. So the question that matters is not "can server@2 serve legacy
 * over HTTP" but "can it serve a legacy client over STDIO". If yes, `sdk@1.x`
 * is unnecessary on the server side entirely.
 *
 * The server child (`q10-stdio-server.ts`) imports only
 * `@modelcontextprotocol/server`. `sdk@1.x` appears here solely as the legacy
 * client, standing in for Claude Code.
 *
 * A stdio connection pins one era at the opening exchange, so each client gets
 * its own child process.
 */
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION as LEGACY_LATEST } from "@modelcontextprotocol/sdk/types.js";

const MODERN_REVISION = "2026-07-28";
const SERVER = new URL("./q10-stdio-server.ts", import.meta.url).pathname;

const spawnArgs = { command: "bun", args: ["run", SERVER] } as const;

async function probeLegacy() {
  const client = new LegacyClient({ name: "q10-stdio-legacy", version: "0.0.0" });
  await client.connect(new LegacyStdio({ ...spawnArgs, stderr: "pipe" }));
  const tools = await client.listTools();
  const call = await client.callTool({ name: "echo", arguments: { message: "legacy-stdio-ok" } });
  const info = client.getServerVersion();
  await client.close();
  return {
    clientSdk: "@modelcontextprotocol/sdk@1.x",
    negotiatedLatest: LEGACY_LATEST,
    serverReported: info,
    tools: tools.tools.map((tool) => tool.name),
    callText: (call as { content?: { text?: string }[] }).content?.[0]?.text,
  };
}

async function probeModern() {
  const client = new ModernClient(
    { name: "q10-stdio-modern", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: MODERN_REVISION } } },
  );
  await client.connect(new ModernStdio({ ...spawnArgs, stderr: "pipe" }));
  const tools = await client.listTools();
  const call = await client.callTool({ name: "echo", arguments: { message: "modern-stdio-ok" } });
  const discover = client.getDiscoverResult();
  await client.close();
  return {
    clientSdk: "@modelcontextprotocol/client@2.x",
    pinnedRevision: MODERN_REVISION,
    discover,
    tools: tools.tools.map((tool) => tool.name),
    callText: (call as { content?: { text?: string }[] }).content?.[0]?.text,
  };
}

const legacy = await probeLegacy().catch((error) => ({ failed: String(error) }));
const modern = await probeModern().catch((error) => ({ failed: String(error) }));

console.log(
  JSON.stringify(
    {
      question: "Q10 stdio — does server@2 alone serve a legacy stdio client?",
      pid: process.pid,
      legacyMode: "default ('serve')",
      serverImports: ["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio"],
      legacy,
      modern,
    },
    null,
    2,
  ),
);
