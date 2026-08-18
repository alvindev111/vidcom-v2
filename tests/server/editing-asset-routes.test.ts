// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ErrorCode, type ProjectId, type RelPath } from "@vidcom/contracts";
import { ok, type AbsolutePath, type ProjectRef, type ResolvedPath } from "@vidcom/core";
import { createServerApp, SESSION_COOKIE } from "@vidcom/server";

const port = 43144;
const projectId = "editing_asset_routes" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "editing-assets",
  root: "/workspace/editing-assets" as AbsolutePath,
  entry: "index.html" as RelPath,
};

function fixture() {
  const fontPaths: string[] = [];
  const writes: unknown[] = [];
  const common = {
    workspace: {
      async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; },
      async resolve(_ref: ProjectRef, path: RelPath) { return ok(path as unknown as ResolvedPath); },
      async stat() { return null; },
    },
    composition: {},
    journal: { async latestRevision() { return 0; } },
  };
  const probe = {
    async probeFont(_ref: ProjectRef, path: RelPath) {
      fontPaths.push(path);
      return ok({ status: "ok" as const, kind: "font" as const, byteSize: 128, family: "Local", style: "Regular" });
    },
    async probeMedia() {
      return ok({ status: "unknown" as const, byteSize: null, reason: "unused" });
    },
  };
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces: {} as never,
    sessions: { verify() { return { valid: true, renewed: false }; } } as never,
    projectReads: {
      ...common,
      events: { async latestProjectSeq() { return 0; } },
      runtimeSource: () => "",
      mimeFromPath: () => "application/octet-stream",
      probe,
    } as never,
    projectWrites: {
      ...common,
      reads: common,
      authority: {
        async mutateSource(request: unknown) {
          writes.push(request);
          return ok({
            projectRevision: 1, entityRevision: null, fileHashes: {}, diagnostics: [], changeSeq: 1,
          });
        },
      },
      approvals: {},
      hashContent: () => `sha256:${"0".repeat(64)}`,
      mimeFromPath: () => null,
    } as never,
  });
  const request = (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    headers.set("Cookie", `${SESSION_COOKIE}=test-session`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  return { request, fontPaths, writes };
}

describe("editing asset routes", () => {
  it("routes metadata through the Core-owned font/media decision before the asset wildcard", async () => {
    const runtime = fixture();
    const response = await runtime.request(
      `/api/v1/projects/${projectId}/assets/assets/local.woff2/metadata`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", family: "Local", style: "Regular" });
    expect(runtime.fontPaths).toEqual(["assets/local.woff2"]);
  });

  it("bypasses generic collection only for exact raw upload and validates query before body", async () => {
    const runtime = fixture();
    const oversized = new Uint8Array(1_048_577);
    const exact = await runtime.request(
      `/api/v1/projects/${projectId}/assets?kind=image&filename=x.png&expectedRevision=0&extra=no`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: oversized },
    );
    expect(exact.status).toBe(400);
    expect(await exact.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });

    const nearMatch = await runtime.request(`/api/v1/projects/${projectId}/assets/not-the-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: oversized,
    });
    expect(nearMatch.status).toBe(413);
    expect(await nearMatch.json()).toMatchObject({ error: { code: ErrorCode.TooLarge } });
  });

  it("dispatches strict entry creation through Core and returns the shared response shape", async () => {
    const runtime = fixture();
    const response = await runtime.request(`/api/v1/projects/${projectId}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "assets/new.txt", kind: "file", expectedRevision: 0 }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      path: "assets/new.txt", kind: "file", revision: 1, diagnostics: [], changeSeq: 1,
    });
    expect(runtime.writes).toHaveLength(1);

    const undeclared = await runtime.request(`/api/v1/projects/${projectId}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "assets/no.txt", kind: "file", expectedRevision: 0, extra: true }),
    });
    expect(undeclared.status).toBe(400);
    expect(runtime.writes).toHaveLength(1);
  });
});
