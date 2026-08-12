import { ErrorCode } from "@vidcom/contracts";
import { DaemonClientError, createDaemonClient, type DaemonClient } from "@vidcom/adapter";
import { describe, expect, it, vi } from "vitest";

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

function stub(responder: (call: Call) => Response | Promise<Response>): {
  client: DaemonClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = createDaemonClient({
    baseUrl: "http://127.0.0.1:43127",
    bearer: "clear-token",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return responder(call);
    },
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const handshakeInput = {
  workspaceRoot: "/canonical/workspace",
  expectedInstanceId: "daemon_first",
  clientKind: "bridge" as const,
  clientVersion: "1.0.0",
};

const handshakeBody = {
  workspaceRoot: "/canonical/workspace",
  instanceId: "daemon_first",
  protocolVersions: ["2026-07-28"],
  daemonVersion: "1.0.0",
};

describe("daemon client", () => {
  it("offers no way to reach an arbitrary route", () => {
    // The absence is the design (DR-6). With a generic request the bridge is an
    // HTTP proxy, every allowlist becomes decoration, and a tool the daemon
    // never published is one hand-written path away. The three render methods
    // are named routes for the same reason: `render` is a thin client over this
    // surface and builds no HTTP client of its own (J.3).
    const { client } = stub(() => json(handshakeBody));
    expect(Object.keys(client).sort()).toEqual([
      "attach",
      "cancelJob",
      "detach",
      "enqueueRender",
      "getJob",
      "handshake",
      "invokeTool",
      "renew",
    ]);
  });

  it("carries the bearer on every call", async () => {
    const { client, calls } = stub((call) => json(
      call.url.includes("/attachments")
        ? { attachmentId: "a", heartbeatEveryMs: 5000, expiresAt: "2026-08-09T00:00:20.000Z" }
        : handshakeBody,
    ));
    await client.handshake(handshakeInput);
    await client.attach("bridge");
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer clear-token",
      "Bearer clear-token",
    ]);
  });

  it("keeps render enqueue, read and cancel inside the authenticated bridge surface", async () => {
    const { client, calls } = stub((call) => {
      if (call.method === "POST" && call.url.endsWith("/renders")) {
        return json({ jobId: "job_render" }, 202);
      }
      if (call.method === "GET") return json({ id: "job_render", status: "queued" });
      return new Response(null, { status: 204 });
    });

    await client.enqueueRender("project/unsafe", {
      idempotencyKey: "render-1",
      renderPresetId: "vertical-shorts",
    });
    await client.getJob("job/unsafe");
    await client.cancelJob("job/unsafe");

    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: "http://127.0.0.1:43127/api/bridge/v1/projects/project%2Funsafe/renders",
        method: "POST",
        body: { idempotencyKey: "render-1", renderPresetId: "vertical-shorts" },
      },
      {
        url: "http://127.0.0.1:43127/api/bridge/v1/jobs/job%2Funsafe",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:43127/api/bridge/v1/jobs/job%2Funsafe/cancel",
        method: "POST",
        body: undefined,
      },
    ]);
  });

  it("refuses a daemon that is not the instance discovery pointed at", async () => {
    // The daemon may have restarted between the discovery read and this call,
    // and it answers happily as itself. The client is the side that knows which
    // instance it meant to reach.
    const { client } = stub(() => json({ ...handshakeBody, instanceId: "daemon_second" }));
    await expect(client.handshake(handshakeInput)).rejects.toMatchObject({
      code: ErrorCode.DaemonIdentityMismatch,
    });
  });

  it("refuses a daemon that owns a different workspace", async () => {
    const { client } = stub(() => json({ ...handshakeBody, workspaceRoot: "/somewhere/else" }));
    await expect(client.handshake(handshakeInput)).rejects.toMatchObject({
      code: ErrorCode.DaemonIdentityMismatch,
    });
  });

  it("keeps the daemon's own error code rather than deriving one from the status", async () => {
    // A status alone cannot tell "this bearer is wrong" from "this workspace
    // belongs to another instance", and those need opposite responses.
    const { client } = stub(() => json(
      { error: { code: ErrorCode.BridgeCredentialInvalid } },
      401,
    ));
    await expect(client.attach("bridge")).rejects.toMatchObject({
      code: ErrorCode.BridgeCredentialInvalid,
    });
  });

  it("preserves a domain error's message, field, details and current revision", async () => {
    const current = { revision: "sha256:current" };
    const { client } = stub(() => json({
      error: {
        code: ErrorCode.WriteConflict,
        message: "the file changed since it was read",
        field: "expectedHash",
        details: { expected: "sha256:stale" },
      },
      current,
    }, 409));

    await expect(client.invokeTool("save_file", {}, {
      protocolVersion: "2026-07-28",
      era: "modern",
    })).rejects.toMatchObject({
      code: ErrorCode.WriteConflict,
      message: "the file changed since it was read",
      field: "expectedHash",
      details: { expected: "sha256:stale", current },
    });
  });

  it("falls back to daemon_unavailable when the daemon says nothing useful", async () => {
    const { client } = stub(() => new Response("gateway", { status: 502 }));
    await expect(client.attach("bridge")).rejects.toMatchObject({
      code: ErrorCode.DaemonUnavailable,
    });
  });

  it("does not retry a call that may already have been applied", async () => {
    // Every route but the handshake mutates daemon state. A timed-out request
    // may well have landed, so a blind retry turns one attachment into two, or
    // one tool call into two side effects.
    let attempts = 0;
    const { client } = stub(() => {
      attempts += 1;
      throw new Error("socket hang up");
    });
    await expect(client.attach("bridge")).rejects.toBeInstanceOf(DaemonClientError);
    expect(attempts).toBe(1);
  });

  it("bounds a daemon that accepts the socket and then stalls", async () => {
    const client = createDaemonClient({
      baseUrl: "http://127.0.0.1:43127",
      bearer: "clear-token",
      deadlineMs: 20,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    await expect(client.attach("bridge")).rejects.toMatchObject({
      code: ErrorCode.DaemonUnavailable,
    });
  });

  it("allows a tool to run longer than the five-second control deadline", async () => {
    vi.useFakeTimers();
    try {
      const client = createDaemonClient({
        baseUrl: "http://127.0.0.1:43127",
        bearer: "clear-token",
        fetch: (_input, init) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(json({ valid: true })), 5_100);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
      });
      const pending = client.invokeTool("validate_project", {}, {
        protocolVersion: "2026-07-28",
        era: "modern",
      });

      await vi.advanceTimersByTimeAsync(5_100);
      await expect(pending).resolves.toEqual({ valid: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows render diagnostics enqueue to outlive the control deadline", async () => {
    vi.useFakeTimers();
    try {
      const client = createDaemonClient({
        baseUrl: "http://127.0.0.1:43127",
        bearer: "clear-token",
        fetch: (_input, init) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(json({ jobId: "job_render" }, 202)), 5_100);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
      });
      const pending = client.enqueueRender("project-long-diagnostics", {
        idempotencyKey: "render-long-diagnostics",
      });

      await vi.advanceTimersByTimeAsync(5_100);
      await expect(pending).resolves.toEqual({ jobId: "job_render" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the tool name in the path and the payload in the body", async () => {
    const { client, calls } = stub(() => json({ ok: true }));
    await client.invokeTool("list_projects", { limit: 1 }, { protocolVersion: "2026-07-28", era: "modern" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:43127/api/bridge/v1/tools/list_projects");
    // The era rides along with the revision: the bridge negotiated it, and the
    // daemon must not have to guess which generation a client speaks.
    expect(calls[0]?.body).toEqual({
      input: { limit: 1 },
      protocolVersion: "2026-07-28",
      era: "modern",
    });
  });

  it("encodes a tool name so it cannot address a different route", async () => {
    // An unknown tool has to come back as an unknown tool, not as a request the
    // daemon routes somewhere else entirely.
    const { client, calls } = stub(() => json({ ok: true }));
    await client.invokeTool("../attachments", {}, { protocolVersion: "2026-07-28", era: "modern" });
    expect(calls[0]?.url).toContain("/tools/..%2Fattachments");
  });

  it("treats an empty detach response as success", async () => {
    const { client } = stub(() => new Response(null, { status: 204 }));
    await expect(client.detach("attachment-1")).resolves.toBeUndefined();
  });
});
