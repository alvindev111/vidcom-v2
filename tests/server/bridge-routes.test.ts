import { ErrorCode } from "@vidcom/contracts";
import {
  AttachmentRegistry,
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  type BridgeRouteDependencies,
} from "@vidcom/server";
import { describe, expect, it } from "vitest";

const PORT = 43_127;
const HOST = `127.0.0.1:${PORT}`;
const WORKSPACE = "/canonical/workspace";
const INSTANCE = "daemon_first";

function build(overrides: Partial<BridgeRouteDependencies> = {}) {
  const clock = { now: () => new Date("2026-08-09T00:00:00.000Z") };
  const invocations: unknown[] = [];
  const bridge: BridgeRouteDependencies = {
    instanceId: INSTANCE,
    workspaceRoot: WORKSPACE,
    daemonVersion: "1.0.0",
    protocolVersions: ["2026-07-28"],
    attachments: new AttachmentRegistry({
      clock,
      instanceId: INSTANCE,
      autoStarted: true,
      hasActiveWork: () => false,
    }),
    bridgeCredentialId: () => Promise.resolve("system-bridge"),
    leaseHeld: () => true,
    invokeTool: (request) => {
      invocations.push(request);
      return Promise.resolve({ ok: true as const, value: { projects: [] } });
    },
    ...overrides,
  };
  const app = createServerApp({
    port: PORT,
    uiOrigins: [],
    nonces: new InMemoryNonceStore(clock),
    sessions: new InMemorySessionStore(clock),
    mcpCredentials: {
      verify: (token) => Promise.resolve(
        token === "system-token"
          ? { id: "system-bridge" }
          : token === "user-token" ? { id: "user-credential" } : null,
      ),
    },
    bridge,
  });

  const call = (path: string, init: RequestInit & { token?: string } = {}) => app.request(
    new Request(`http://${HOST}${path}`, {
      ...init,
      headers: {
        Host: HOST,
        ...(init.token === undefined ? {} : { Authorization: `Bearer ${init.token}` }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    }),
  );
  return { call, invocations, bridge };
}

const handshakeBody = JSON.stringify({
  workspaceRoot: WORKSPACE,
  expectedInstanceId: INSTANCE,
  clientKind: "bridge",
  clientVersion: "1.0.0",
});

describe("bridge routes", () => {
  it("answers a handshake for the instance the client expected", async () => {
    const { call } = build();
    const response = await call("/api/bridge/v1/handshake", {
      method: "POST",
      body: handshakeBody,
      token: "system-token",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaceRoot: WORKSPACE,
      instanceId: INSTANCE,
      protocolVersions: ["2026-07-28"],
      daemonVersion: "1.0.0",
    });
  });

  it.each([
    ["a different instance", { workspaceRoot: WORKSPACE, expectedInstanceId: "daemon_second" }],
    ["a different workspace", { workspaceRoot: "/elsewhere", expectedInstanceId: INSTANCE }],
  ])("refuses a handshake naming %s", async (_label, body) => {
    // A live PID on a live port proves only that something is listening. After a
    // restart the thing listening is a different daemon that would answer every
    // later call convincingly.
    const { call } = build();
    const response = await call("/api/bridge/v1/handshake", {
      method: "POST",
      body: JSON.stringify(body),
      token: "system-token",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: ErrorCode.DaemonIdentityMismatch },
    });
  });

  it("turns away a user MCP credential", async () => {
    // A user credential is a perfectly valid bearer for /api/mcp. Accepting it
    // here would hand any configured agent the daemon's own lifecycle controls.
    const { call } = build();
    const response = await call("/api/bridge/v1/attachments", {
      method: "POST",
      body: JSON.stringify({ kind: "bridge" }),
      token: "user-token",
    });
    expect(await response.json()).toMatchObject({
      error: { code: ErrorCode.BridgeCredentialInvalid },
    });
  });

  it("turns away a request with no bearer at all", async () => {
    const { call } = build();
    const response = await call("/api/bridge/v1/ready");
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.CredentialInvalid } });
  });

  it("guards only its own routes, not the whole API", async () => {
    // This router mounts at the root of the API app. A `*` guard would demand
    // the system bridge credential on every browser request in the product, and
    // it showed up as a 503 on `/v1/projects` that had nothing to do with the
    // bridge. Found by the runtime smoke, not by reading the router.
    const { call } = build({ bridgeCredentialId: () => Promise.resolve(null) });
    const response = await call("/api/v1/health");
    const body = await response.json() as { error?: { code?: string } };
    expect(body.error?.code).not.toBe(ErrorCode.BridgeCredentialUnavailable);
  });

  it("says so when the daemon has no system credential yet", async () => {
    const { call } = build({ bridgeCredentialId: () => Promise.resolve(null) });
    const response = await call("/api/bridge/v1/ready", { token: "system-token" });
    expect(await response.json()).toMatchObject({
      error: { code: ErrorCode.BridgeCredentialUnavailable },
    });
  });

  it("reports whether the lease is held, which health cannot", async () => {
    // A process can be alive and answering while holding no workspace lease, and
    // a client that attaches to it gets a daemon that cannot write.
    const { call } = build({ leaseHeld: () => false });
    expect(await (await call("/api/bridge/v1/ready", { token: "system-token" })).json())
      .toMatchObject({ leaseHeld: false, instanceId: INSTANCE });
  });

  it("attaches, renews and detaches", async () => {
    const { call } = build();
    const attached = await (await call("/api/bridge/v1/attachments", {
      method: "POST",
      body: JSON.stringify({ kind: "bridge" }),
      token: "system-token",
    })).json() as { attachmentId: string; heartbeatEveryMs: number };
    expect(attached.heartbeatEveryMs).toBe(5_000);

    const renewed = await call(`/api/bridge/v1/attachments/${attached.attachmentId}`, {
      method: "PUT",
      token: "system-token",
    });
    expect(renewed.status).toBe(200);

    const detached = await call(`/api/bridge/v1/attachments/${attached.attachmentId}`, {
      method: "DELETE",
      token: "system-token",
    });
    expect(detached.status).toBe(204);
  });

  it("tells a client to attach again rather than refusing it", async () => {
    // An attachment that expired while its client was stalled is not an
    // authorization problem, and "attach again" is the only useful answer.
    const { call } = build();
    const response = await call("/api/bridge/v1/attachments/never-issued", {
      method: "PUT",
      token: "system-token",
    });
    expect(response.status).toBe(404);
  });

  it("refuses an attachment kind the daemon does not issue", async () => {
    const { call } = build();
    const response = await call("/api/bridge/v1/attachments", {
      method: "POST",
      body: JSON.stringify({ kind: "admin" }),
      token: "system-token",
    });
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
  });

  it("runs a tool that the published catalogue contains", async () => {
    const { call, invocations } = build();
    const response = await call("/api/bridge/v1/tools/list_projects", {
      method: "POST",
      body: JSON.stringify({ input: {}, protocolVersion: "2026-07-28" }),
      token: "system-token",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
    // Identity is forwarded, never invented at the bridge: the daemon writes
    // the audit entry, so a bridge that dies mid-call cannot take the record of
    // the call with it.
    expect(invocations[0]).toMatchObject({
      name: "list_projects",
      credentialId: "system-bridge",
      protocolVersion: "2026-07-28",
    });
  });

  it("stops an unknown tool name at the route, not in Core", async () => {
    // Forwarding it would let the bridge address whatever the daemon happens to
    // have registered, which is the allowlist existing in name only.
    const { call, invocations } = build();
    const response = await call("/api/bridge/v1/tools/rm_rf", {
      method: "POST",
      body: JSON.stringify({ input: {}, protocolVersion: "2026-07-28" }),
      token: "system-token",
    });
    expect(response.status).toBe(404);
    expect(invocations).toEqual([]);
  });

  it("requires the protocol version the result will be stamped with", async () => {
    const { call } = build();
    const response = await call("/api/bridge/v1/tools/list_projects", {
      method: "POST",
      body: JSON.stringify({ input: {} }),
      token: "system-token",
    });
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
  });

  it("passes a tool failure through with the code the daemon gave it", async () => {
    const { call } = build({
      invokeTool: () => Promise.resolve({
        ok: false as const,
        error: { code: ErrorCode.SchemaInvalid, message: "tool input does not match its strict schema" },
      }),
    });
    const response = await call("/api/bridge/v1/tools/save_file", {
      method: "POST",
      body: JSON.stringify({ input: {}, protocolVersion: "2026-07-28" }),
      token: "system-token",
    });
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
  });
});
