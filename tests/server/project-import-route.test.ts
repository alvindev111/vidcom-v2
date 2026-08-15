import { ErrorCode } from "@vidcom/contracts";
import { importIdempotencyKey } from "@vidcom/core";
import { createDeliveryLoopRoutes, mapHttpError } from "@vidcom/server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

function hash(content: string): string {
  // Deterministic and dependency-free; the real one is SHA-256 from the adapter.
  // Padded on the right, because the key takes the first 32 characters and a
  // left-padded digest would hand it a run of zeros for every input.
  let value = 0;
  for (const character of content) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return `sha256:${value.toString(16).repeat(16).slice(0, 64)}`;
}

function app(overrides: Record<string, unknown> = {}) {
  const started: Array<{ selectionToken: string; targetName?: string }> = [];
  const routes = createDeliveryLoopRoutes({
    workspaceRoot: "/w",
    workspaceOverview: () => Promise.resolve({}),
    activateWorkspace: () => Promise.reject(new Error("unused")),
    startProjectImport: (input: { selectionToken: string; targetName?: string }) => {
      started.push(input);
      return Promise.resolve({ ok: true as const, value: { jobId: "job_import_1" } });
    },
    ...overrides,
  } as never);
  // Mounted behind the same error mapper the app uses. Without it a domain
  // refusal surfaces as a 500 and the test would be measuring the harness.
  const mounted = new Hono().route("/", routes);
  mounted.onError((error, c) => mapHttpError(error, c));
  return { routes: mounted, started };
}

const call = (routes: ReturnType<typeof createDeliveryLoopRoutes>, body: unknown) => routes.request(
  new Request("http://local/v1/projects/imports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
);

describe("project import route", () => {
  it("accepts the request and answers with the job that owns it", async () => {
    // 202 rather than 201: copying a project tree is not something to hold a
    // request open for, and the job id is what the client polls.
    const { routes, started } = app();
    const response = await call(routes, { sourceToken: "token-1", targetName: "My Copy" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: "job_import_1" });
    expect(started).toEqual([{ selectionToken: "token-1", targetName: "My Copy" }]);
  });

  it("takes a selection token, never a path", async () => {
    // A path a client can type is a path any page can send, and the point of
    // browse is that the server acts only on directories it handed out.
    const { routes, started } = app();
    const response = await call(routes, { sourcePath: "/etc" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
    expect(started).toEqual([]);
  });

  it("refuses a target name that is not a string", async () => {
    const { routes } = app();
    const response = await call(routes, { sourceToken: "token-1", targetName: 7 });
    expect(response.status).toBe(400);
  });

  it("passes a domain refusal through with its own code", async () => {
    const { routes } = app({
      startProjectImport: () => Promise.resolve({
        ok: false,
        error: { code: ErrorCode.PathInvalid, message: "the source is inside this workspace" },
      }),
    });
    const response = await call(routes, { sourceToken: "token-1" });
    expect(await response.json()).toMatchObject({ error: { code: ErrorCode.PathInvalid } });
  });
});

describe("import idempotency key", () => {
  it("is the same for the same request", async () => {
    // The unique index cannot do this: it is scoped to (project_id, type, key),
    // an import has no project_id until it finishes, and SQLite treats every
    // NULL as distinct — so the index would accept a hundred identical imports.
    const input = {
      workspaceRoot: "/w",
      sourceCanonicalIdentity: "dev:ino",
      targetName: "copy",
    };
    expect(importIdempotencyKey(input, hash)).toBe(importIdempotencyKey(input, hash));
  });

  it("differs when any part of the request differs", () => {
    const base = { workspaceRoot: "/w", sourceCanonicalIdentity: "dev:ino" };
    const keys = new Set([
      importIdempotencyKey(base, hash),
      importIdempotencyKey({ ...base, workspaceRoot: "/other" }, hash),
      importIdempotencyKey({ ...base, sourceCanonicalIdentity: "dev:other" }, hash),
      importIdempotencyKey({ ...base, targetName: "copy" }, hash),
    ]);
    expect(keys.size).toBe(4);
  });

  it("cannot be confused by a path that contains the separator", () => {
    // Joining on anything a path can hold lets two different requests build the
    // same material, so the parts are joined on NUL.
    const left = importIdempotencyKey({
      workspaceRoot: "/w",
      sourceCanonicalIdentity: "a b",
    }, hash);
    const right = importIdempotencyKey({
      workspaceRoot: "/w a",
      sourceCanonicalIdentity: "b",
    }, hash);
    expect(left).not.toBe(right);
  });
});
