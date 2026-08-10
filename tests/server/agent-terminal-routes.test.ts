import { ErrorCode, type AgentTerminalFrame, type ProjectId } from "@vidcom/contracts";
import type { AgentTerminalPort, AgentTerminalSession, AgentTerminalSpec } from "@vidcom/core";
import { createServerApp, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";
import { describe, expect, it } from "vitest";

const id = "project-alpha" as ProjectId;

function fakeSession(spec: AgentTerminalSpec) {
  const listeners = new Set<(frame: AgentTerminalFrame) => void>();
  const written: string[] = [];
  const sizes: Array<[number, number]> = [];
  let closed = false;
  const session: AgentTerminalSession = {
    id: "terminal_1",
    projectId: spec.projectId,
    agent: spec.agent,
    write: (data) => { written.push(data); },
    resize: (cols, rows) => { sizes.push([cols, rows]); },
    close: () => {
      closed = true;
      for (const listener of listeners) listener({ type: "exit", exitCode: 0 });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener({ type: "data", data: "banner\r\n" });
      return () => listeners.delete(listener);
    },
  };
  return { session, written, sizes, isClosed: () => closed };
}

function fixture() {
  const port = 43220;
  const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
  const nonces = new InMemoryNonceStore(clock);
  const sessions = new InMemorySessionStore(clock);
  const opened: ReturnType<typeof fakeSession>[] = [];
  const live = new Map<ProjectId, AgentTerminalSession>();
  const terminals: AgentTerminalPort = {
    async open(spec) {
      const created = fakeSession(spec);
      opened.push(created);
      live.set(spec.projectId, created.session);
      return created.session;
    },
    findByProject: (projectId) => live.get(projectId) ?? null,
    find: (sessionId) => [...live.values()].find((session) => session.id === sessionId) ?? null,
    liveCount: () => live.size,
  };
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces,
    sessions,
    agentTerminal: {
      workspace: {
        async readProjectRef(projectId) {
          return projectId === id
            ? { id, slug: "alpha", root: "/workspace/alpha", entry: "index.html" } as never
            : null;
        },
      },
      terminals,
      mcpServer: {
        name: "vidcom",
        url: "http://127.0.0.1:7788/api/mcp",
        tokenEnvVar: "VIDCOM_MCP_TOKEN",
        token: "secret-bearer",
      },
      workspaceRoot: "/workspace" as never,
      agentKit: { async apply() { return { ok: true, value: {} } as never; } },
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    return app.request(`${base}${pathname}`, { ...init, headers });
  };
  const authenticate = async () => {
    const response = await request("/api/v1/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: nonces.issue() }),
    });
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  return { request, authenticate, opened };
}

async function start(
  request: ReturnType<typeof fixture>["request"],
  cookie: string,
  body: unknown = { agent: "codex", cols: 80, rows: 24 },
  project: string = id,
) {
  return request(`/api/v1/projects/${project}/agent-terminal`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agent terminal routes", () => {
  it("refuses every verb without a session cookie", async () => {
    const { request } = fixture();
    const started = await start(request, "");
    const streamed = await request(`/api/v1/projects/${id}/agent-terminal/terminal_1/stream`);

    expect(started.status).toBe(401);
    expect(streamed.status).toBe(401);
  });

  it("starts a session, then re-attaches instead of starting a second one", async () => {
    const { request, authenticate, opened } = fixture();
    const cookie = await authenticate();

    const first = await start(request, cookie);
    const second = await start(request, cookie, { agent: "codex", cols: 100, rows: 30 });

    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      sessionId: "terminal_1",
      agent: "codex",
      mcpServerName: "vidcom",
      reattached: false,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ reattached: true });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.sizes).toEqual([[100, 30]]);
  });

  it("rejects a size outside the contract before anything is spawned", async () => {
    const { request, authenticate, opened } = fixture();
    const cookie = await authenticate();

    const response = await start(request, cookie, { agent: "codex", cols: 0, rows: 24 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
    expect(opened).toHaveLength(0);
  });

  it("rejects an agent the enum does not name", async () => {
    const { request, authenticate, opened } = fixture();
    const cookie = await authenticate();

    const response = await start(request, cookie, { agent: "bash", cols: 80, rows: 24 });

    expect(response.status).toBe(400);
    expect(opened).toHaveLength(0);
  });

  it("streams replayed output as SSE frames", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    await start(request, cookie);

    const stream = await request(`/api/v1/projects/${id}/agent-terminal/terminal_1/stream`, {
      headers: { Cookie: cookie },
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    expect(first).toContain("event: data");
    expect(first).toContain(JSON.stringify({ type: "data", data: "banner\r\n" }));
  });

  it("routes typing and resizing to the session, and closes it on delete", async () => {
    const { request, authenticate, opened } = fixture();
    const cookie = await authenticate();
    await start(request, cookie);
    const json = (body: unknown) => ({
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const typed = await request(`/api/v1/projects/${id}/agent-terminal/terminal_1/input`, json({ data: "ls\r" }));
    const resized = await request(
      `/api/v1/projects/${id}/agent-terminal/terminal_1/resize`,
      json({ cols: 120, rows: 40 }),
    );
    const stopped = await request(`/api/v1/projects/${id}/agent-terminal/terminal_1`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect([typed.status, resized.status, stopped.status]).toEqual([204, 204, 204]);
    expect(opened[0]!.written).toEqual(["ls\r"]);
    expect(opened[0]!.sizes).toEqual([[120, 40]]);
    expect(opened[0]!.isClosed()).toBe(true);
  });

  it("will not reach a session through a project that does not own it", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    await start(request, cookie);

    const response = await request("/api/v1/projects/project-beta/agent-terminal/terminal_1/input", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ data: "ls\r" }),
    });

    expect(response.status).toBe(404);
  });

  it("reports a project that does not exist as project_not_found", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();

    const response = await start(request, cookie, { agent: "codex", cols: 80, rows: 24 }, "project-missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.ProjectNotFound } });
  });
});
