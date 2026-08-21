import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { ErrorCode, SUPPORTED_REVISIONS } from "@vidcom/contracts";
import { createMcpHttpHandlers } from "@vidcom/mcp";
import {
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  mapHttpError,
  mcpBearerAuth,
  SESSION_COOKIE,
  type McpAuthEnv,
  type McpCredentialVerifier,
} from "@vidcom/server";
import type { ToolAuditEntry } from "@vidcom/core";

import { createTransportRegistry } from "../mcp/support";

function protectedApp(credentials: McpCredentialVerifier): Hono<McpAuthEnv> {
  const app = new Hono<McpAuthEnv>();
  app.use("*", mcpBearerAuth(credentials));
  app.post("/api/mcp", (c) => c.json({ credentialId: c.get("credentialId") }));
  app.onError(mapHttpError);
  return app;
}

describe("mcpBearerAuth", () => {
  it("sets only the verified credential ID in request context", async () => {
    const seen: string[] = [];
    const app = protectedApp({
      async verify(secret) {
        seen.push(secret);
        return secret === "vcmcp_valid" ? { id: "credential_http" } : null;
      },
    });
    const response = await app.request("/api/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer vcmcp_valid" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ credentialId: "credential_http" });
    expect(seen).toEqual(["vcmcp_valid"]);
  });

  it.each([
    ["missing", {}],
    ["session cookie", { Cookie: `${SESSION_COOKIE}=browser-session` }],
    ["wrong scheme", { Authorization: "Basic vcmcp_valid" }],
    ["invalid bearer", { Authorization: "Bearer vcmcp_invalid" }],
  ])("returns one credential_invalid response for %s", async (_name, headers) => {
    const app = protectedApp({ verify: async () => null });
    const response = await app.request("/api/mcp", { method: "POST", headers });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: ErrorCode.CredentialInvalid, message: "credential_invalid" },
    });
  });
});

describe("MCP perimeter branch", () => {
  function server(trace: string[], requests?: Array<{ key: string; credentialId: string }>) {
    const clock = { now: () => new Date("2026-08-02T00:00:00.000Z") };
    const handler = (key: string) => async (
      _request: Request,
      options?: { authInfo?: { clientId: string } },
    ) => {
      requests?.push({ key, credentialId: options?.authInfo?.clientId ?? "" });
      return Response.json({ key });
    };
    return createServerApp({
      port: 43123,
      uiOrigins: ["http://127.0.0.1:3000"],
      nonces: new InMemoryNonceStore(clock),
      sessions: new InMemorySessionStore(clock),
      mcpCredentials: { verify: async (secret) => secret === "vcmcp_valid" ? { id: "credential_http" } : null },
      ...(requests ? {
        mcp: {
          handlers: new Map([
            ["", handler("entry")],
            ["2026-07-28", handler("2026-07-28")],
            ["latest", handler("latest")],
          ]),
          defaultRevision: "2026-07-28",
        },
      } : {}),
      trace: (step) => trace.push(step),
    });
  }

  it("runs Host and CORS before MCP auth, then body handling", async () => {
    const trace: string[] = [];
    const app = server(trace);
    const hostileHost = await app.request("http://127.0.0.1:43123/api/mcp", {
      method: "POST",
      headers: { Host: "evil.example", Authorization: "Bearer invalid" },
    });
    expect(hostileHost.status).toBe(403);
    expect(trace).toEqual(["requestId", "logger", "hostCheck", "errorMapper"]);

    trace.length = 0;
    const hostileOrigin = await app.request("http://127.0.0.1:43123/api/mcp", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:43123",
        Origin: "https://evil.example",
        Authorization: "Bearer invalid",
      },
    });
    expect(hostileOrigin.status).toBe(403);
    expect(trace).toEqual(["requestId", "logger", "hostCheck", "cors", "errorMapper"]);

    trace.length = 0;
    const accepted = await app.request("http://127.0.0.1:43123/api/mcp", {
      method: "POST",
      headers: { Host: "127.0.0.1:43123", Authorization: "Bearer vcmcp_valid" },
    });
    expect(accepted.status).toBe(404);
    expect(trace).toEqual([
      "requestId", "logger", "hostCheck", "cors", "browserRequestGuard", "auth", "bodyLimit",
    ]);
  });

  it("dispatches entry, exact revision and latest with the verified credential ID", async () => {
    const requests: Array<{ key: string; credentialId: string }> = [];
    const app = server([], requests);
    for (const pathname of ["/api/mcp", "/api/mcp/2026-07-28", "/api/mcp/latest"]) {
      const response = await app.request(`http://127.0.0.1:43123${pathname}`, {
        method: "POST",
        headers: { Host: "127.0.0.1:43123", Authorization: "Bearer vcmcp_valid" },
      });
      expect(response.status).toBe(200);
    }
    expect(requests).toEqual([
      { key: "entry", credentialId: "credential_http" },
      { key: "2026-07-28", credentialId: "credential_http" },
      { key: "latest", credentialId: "credential_http" },
    ]);
  });
});

describe("Hono MCP SDK boundary", () => {
  function mountedApp(
    mcp: ReturnType<typeof createMcpHttpHandlers>,
    verify: McpCredentialVerifier["verify"] = async (secret) =>
      secret === "vcmcp_valid" ? { id: "credential_http" } : null,
    trace: string[] = [],
  ) {
    const clock = { now: () => new Date("2026-08-02T00:00:00.000Z") };
    return createServerApp({
      port: 43123,
      uiOrigins: [],
      nonces: new InMemoryNonceStore(clock),
      sessions: new InMemorySessionStore(clock),
      mcpCredentials: { verify },
      mcp,
      trace: (step) => trace.push(step),
    });
  }

  function request(app: ReturnType<typeof mountedApp>, pathname = "/api/mcp", init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Host", "127.0.0.1:43123");
    return app.request(`http://127.0.0.1:43123${pathname}`, { ...init, headers });
  }

  it("returns the same app-level rejection for missing, cookie-only and invalid credentials", async () => {
    const mcp = createMcpHttpHandlers(createTransportRegistry());
    const app = mountedApp(mcp);
    try {
      const responses = await Promise.all([
        request(app, "/api/mcp", { method: "POST" }),
        request(app, "/api/mcp", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=browser` } }),
        request(app, "/api/mcp", { method: "POST", headers: { Authorization: "Bearer invalid" } }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: { code: ErrorCode.CredentialInvalid, message: "credential_invalid" },
        });
      }
    } finally {
      await mcp.close();
    }
  });

  it("propagates credentialId through entry, every exact pin and latest without retaining the bearer", async () => {
    const audits: ToolAuditEntry[] = [];
    const mcp = createMcpHttpHandlers(createTransportRegistry(audits));
    const logs: string[] = [];
    const clock = { now: () => new Date("2026-08-02T00:00:00.000Z") };
    const app = createServerApp({
      port: 43123,
      uiOrigins: [],
      nonces: new InMemoryNonceStore(clock),
      sessions: new InMemorySessionStore(clock),
      mcpCredentials: { verify: async () => ({ id: "credential_http" }) },
      mcp,
      log: (line) => logs.push(line),
    });
    try {
      const targets = [
        { pathname: "/api/mcp", revision: null },
        ...SUPPORTED_REVISIONS.map((revision) => ({ pathname: `/api/mcp/${revision}`, revision })),
        { pathname: "/api/mcp/latest", revision: SUPPORTED_REVISIONS[0] },
      ];
      for (const [index, target] of targets.entries()) {
        const modern = target.revision === "2026-07-28";
        const response = await request(app, target.pathname, {
          method: "POST",
          headers: {
            Authorization: "Bearer vcmcp_top_secret",
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            ...(target.revision ? { "MCP-Protocol-Version": target.revision } : {}),
            ...(modern ? { "Mcp-Method": "tools/call", "Mcp-Name": "echo_project" } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index + 1,
            method: "tools/call",
            params: {
              name: "echo_project",
              arguments: { projectId: `project-audit-${index}` },
              ...(modern ? {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": target.revision,
                  "io.modelcontextprotocol/clientInfo": { name: "auth-forwarding-test", version: "1.0.0" },
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              } : {}),
            },
          }),
        });
        expect(response.status, target.pathname).toBe(200);
      }
      expect(audits).toHaveLength(targets.length);
      expect(audits).toEqual(targets.map(() => expect.objectContaining({
        credentialId: "credential_http",
        tool: "echo_project",
      })));
      expect(JSON.stringify(audits)).not.toContain("vcmcp_top_secret");
      expect(logs.join("\n")).not.toContain("vcmcp_top_secret");
    } finally {
      await mcp.close();
    }
  });

  it.each(["GET", "DELETE"])("keeps SDK %s rejection behind valid auth", async (method) => {
    const mcp = createMcpHttpHandlers(createTransportRegistry());
    const trace: string[] = [];
    const app = mountedApp(mcp, undefined, trace);
    try {
      const response = await request(app, "/api/mcp", {
        method,
        headers: { Authorization: "Bearer vcmcp_valid" },
      });
      expect(response.status).toBe(405);
      expect(trace).toEqual([
        "requestId", "logger", "hostCheck", "cors", "browserRequestGuard", "auth", "bodyLimit",
      ]);
    } finally {
      await mcp.close();
    }
  });
});
