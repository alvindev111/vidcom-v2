import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernHttp } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpHttpHandlers } from "@vidcom/mcp";
import {
  bindLoopback,
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  type LoopbackListener,
} from "@vidcom/server";

import { createTransportRegistry } from "../mcp/support";

const MODERN_REVISION = "2026-07-28";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).reverse().map((close) => close()));
});

async function fixture(): Promise<{
  listener: LoopbackListener;
  origin: string;
}> {
  const clock = { now: () => new Date("2026-08-02T00:00:00.000Z") };
  const mcp = createMcpHttpHandlers(createTransportRegistry());
  const listener = await bindLoopback((port) => createServerApp({
    port,
    uiOrigins: ["http://127.0.0.1:3000"],
    nonces: new InMemoryNonceStore(clock),
    sessions: new InMemorySessionStore(clock),
    mcpCredentials: {
      verify: async (secret) => secret === "vcmcp_listener" ? { id: "credential_listener" } : null,
    },
    mcp,
  }));
  closers.push(() => mcp.close(), () => listener.close());
  return { listener, origin: `http://127.0.0.1:${listener.port}` };
}

function authorizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", "Bearer vcmcp_listener");
  return fetch(input, { ...init, headers });
}

function legacyListBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}

function postWithHost(origin: string, host: string): Promise<{ status: number; body: string }> {
  const target = new URL("/api/mcp", origin);
  const body = legacyListBody();
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        Host: host,
        Authorization: "Bearer vcmcp_listener",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("real MCP loopback listener", () => {
  it("serves entry, pinned and latest while enforcing Host, CORS and body limits", async () => {
    const { origin } = await fixture();
    const headers = {
      Authorization: "Bearer vcmcp_listener",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };

    for (const pathname of ["/api/mcp", "/api/mcp/2025-03-26"]) {
      const response = await fetch(`${origin}${pathname}`, {
        method: "POST",
        headers,
        body: legacyListBody(),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("echo_project");
    }

    const latestTransport = new ModernHttp(new URL(`${origin}/api/mcp/latest`), {
      fetch: authorizedFetch,
    });
    const latest = new ModernClient(
      { name: "listener-latest", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: MODERN_REVISION } } },
    );
    try {
      await latest.connect(latestTransport);
      expect(latest.getProtocolEra()).toBe("modern");
      expect((await latest.listTools()).tools).toHaveLength(3);
    } finally {
      await latest.close();
    }

    const hostileHost = await postWithHost(origin, "evil.example");
    expect(hostileHost.status).toBe(403);

    const hostileOrigin = await fetch(`${origin}/api/mcp`, {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: legacyListBody(),
    });
    expect(hostileOrigin.status).toBe(403);

    const tooLarge = await fetch(`${origin}/api/mcp`, {
      method: "POST",
      headers,
      body: "x".repeat(1_048_577),
    });
    expect(tooLarge.status).toBe(413);
  });

  it("serves legacy and modern SDK clients simultaneously and closes cleanly", async () => {
    const { listener, origin } = await fixture();
    const legacyTransport = new LegacyHttp(new URL(`${origin}/api/mcp`), { fetch: authorizedFetch });
    const modernTransport = new ModernHttp(new URL(`${origin}/api/mcp`), { fetch: authorizedFetch });
    const legacy = new LegacyClient({ name: "listener-legacy", version: "1.0.0" });
    const modern = new ModernClient(
      { name: "listener-modern", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: MODERN_REVISION } } },
    );

    try {
      await Promise.all([legacy.connect(legacyTransport), modern.connect(modernTransport)]);
      const [legacyResult, modernResult] = await Promise.all([
        legacy.callTool({ name: "echo_project", arguments: { projectId: "legacy-live" } }),
        modern.callTool({ name: "echo_project", arguments: { projectId: "modern-live" } }),
      ]);
      expect(legacyResult.structuredContent).toEqual({ projectId: "legacy-live" });
      expect(modernResult.structuredContent).toEqual({ projectId: "modern-live" });
    } finally {
      await Promise.all([legacy.close(), modern.close()]);
    }

    await closers.pop()!();
    await closers.pop()!();
    expect(listener.server.listening).toBe(false);
  });
});
import { request as httpRequest } from "node:http";
