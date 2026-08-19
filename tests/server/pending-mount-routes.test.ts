// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import { ok, type AbsolutePath, type PendingMount, type ProjectRef, type ResolvedPath } from "@vidcom/core";
import { createServerApp, SESSION_COOKIE } from "@vidcom/server";

const port = 43155;
const projectId = "pending_mount_routes" as ProjectId;
const OPERATION = "01K1ABCDEFGHJKMNPQRSTVWXYZ";
const ASSET = "assets/clip.mp4" as RelPath;
const ASSET_HASH = `sha256:${"a".repeat(64)}` as ContentHash;
const ENTRY_HASH = `sha256:${"b".repeat(64)}` as ContentHash;
const ref: ProjectRef = {
  id: projectId,
  slug: "pending-mount",
  root: "/workspace/pending-mount" as AbsolutePath,
  entry: "index.html" as RelPath,
};

const record: PendingMount = {
  operationId: OPERATION,
  projectId,
  assetPath: ASSET,
  assetContentHash: ASSET_HASH,
  uploadFingerprint: `sha256:${"c".repeat(64)}` as ContentHash,
  atSeconds: 1.5,
  trackIndex: 0,
  state: "uploaded_unmounted",
  lastFailure: { code: "interrupted", message: "Mount interrupted" },
  mountedSceneId: null,
  mountedRevision: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:01:00.000Z",
};

const model = {
  project: { id: projectId, width: 1920, height: 1080, duration: 4, sceneCount: 1 },
  scenes: [{ id: "scene-1", src: "compositions/scene-1.html", start: 0, duration: 4, trackIndex: 0 }],
  frameRate: 30,
} as never;

function fixture(options: {
  lookup?: "active" | "expired" | "never-seen";
  abandonFails?: boolean;
} = {}) {
  const writes: unknown[] = [];
  const abandoned: Array<{ projectId: string; operationId: string; reason: string }> = [];
  const listed: string[] = [];
  const hashes = new Map<RelPath, ContentHash>([[ASSET, ASSET_HASH], [ref.entry, ENTRY_HASH]]);
  const pendingMount = {
    async lookup(id: ProjectId, operationId: string) {
      if (id !== projectId || operationId !== OPERATION) return { state: "never-seen" as const };
      if (options.lookup === "expired") return { state: "expired" as const };
      if (options.lookup === "never-seen") return { state: "never-seen" as const };
      return { state: "active" as const, record };
    },
    async listPending(id: ProjectId) {
      listed.push(id);
      return [record as PendingMount & { state: "uploaded_unmounted" }];
    },
    async markFailed() {},
    async abandon(id: ProjectId, operationId: string, reason: string) {
      if (options.abandonFails) {
        throw Object.assign(new Error("pending mount can no longer be abandoned"), {
          code: ErrorCode.WriteConflict,
        });
      }
      abandoned.push({ projectId: id, operationId, reason });
    },
  };
  const probe = {
    async probeFont() { return ok({ status: "unknown" as const, byteSize: null, reason: "unused" }); },
    async probeMedia() {
      return ok({
        status: "ok" as const, kind: "media" as const, byteSize: 10,
        durationSeconds: 7.5, width: 1920, height: 1080, codec: "h264",
      });
    },
  };
  const common = {
    workspace: {
      async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; },
      async resolve(_ref: ProjectRef, path: RelPath) { return ok(path as unknown as ResolvedPath); },
      async readHash(resolved: ResolvedPath) { return hashes.get(resolved as unknown as RelPath) ?? null; },
      async stat() { return null; },
    },
    composition: {
      async parseProject() { return model; },
      async applyOps() { return ok("<main/>"); },
    },
    journal: { async latestRevision() { return 1; } },
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
          return ok({ projectRevision: 2, entityRevision: null, fileHashes: {}, diagnostics: [], changeSeq: 4 });
        },
      },
      approvals: {
        async request() { return "grant_pending"; },
        async issue(grantId: string) { return ok(grantId); },
      },
      pendingMount,
      probe,
      hashContent: () => `sha256:${"0".repeat(64)}` as ContentHash,
      mimeFromPath: () => null,
      clock: { now: () => new Date("2026-08-02T00:02:00.000Z") },
    } as never,
  });
  const request = (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    headers.set("Cookie", `${SESSION_COOKIE}=test-session`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  return { request, writes, abandoned, listed };
}

const json = { "Content-Type": "application/json" };

describe("pending mount routes", () => {
  it("mounts an existing asset through Core and answers with the wrapper scene", async () => {
    const runtime = fixture();
    const response = await runtime.request(`/api/v1/projects/${projectId}/assets/mount`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        assetPath: ASSET,
        assetContentHash: ASSET_HASH,
        atSeconds: 0,
        trackIndex: 0,
        expectedContentHash: ENTRY_HASH,
        onOverflow: "extend-root",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      durationSeconds: 7.5, revision: 2, diagnostics: [], changeSeq: 4,
    });
    expect(runtime.writes).toHaveLength(1);
  });

  it("accepts a retry that carries only its operation id and rejects one that carries placement", async () => {
    const runtime = fixture();
    const retry = await runtime.request(`/api/v1/projects/${projectId}/assets/mount`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ operationId: OPERATION, expectedContentHash: ENTRY_HASH, onOverflow: "shrink" }),
    });
    expect(retry.status).toBe(201);
    expect(runtime.writes).toHaveLength(1);

    const redirected = await runtime.request(`/api/v1/projects/${projectId}/assets/mount`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        operationId: OPERATION,
        assetPath: "assets/other.mp4",
        atSeconds: 9,
        trackIndex: 3,
        expectedContentHash: ENTRY_HASH,
        onOverflow: "shrink",
      }),
    });
    expect(redirected.status).toBe(400);
    expect(await redirected.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
    expect(runtime.writes).toHaveLength(1);
  });

  it("lists the project's unmounted uploads and reads one operation back", async () => {
    const runtime = fixture();
    const collection = await runtime.request(`/api/v1/projects/${projectId}/pending-mounts`);
    expect(collection.status).toBe(200);
    expect(await collection.json()).toEqual({
      items: [{ ...record, state: "uploaded_unmounted" }],
    });
    expect(runtime.listed).toEqual([projectId]);

    const item = await runtime.request(`/api/v1/projects/${projectId}/pending-mounts/${OPERATION}`);
    expect(item.status).toBe(200);
    expect(await item.json()).toEqual(record);
  });

  it("answers 404 for an expired, unknown or malformed operation", async () => {
    const expired = fixture({ lookup: "expired" });
    expect((await expired.request(`/api/v1/projects/${projectId}/pending-mounts/${OPERATION}`)).status).toBe(404);
    const unseen = fixture({ lookup: "never-seen" });
    expect((await unseen.request(`/api/v1/projects/${projectId}/pending-mounts/${OPERATION}`)).status).toBe(404);
    const other = fixture();
    expect((await other.request(`/api/v1/projects/${projectId}/pending-mounts/01K1ZZZZZZZZZZZZZZZZZZZZZZ`)).status)
      .toBe(404);
    const malformed = await other.request(`/api/v1/projects/${projectId}/pending-mounts/not-a-ulid`);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
  });

  it("abandons one operation of the project in the path and maps a lost race to 409", async () => {
    const runtime = fixture();
    const deleted = await runtime.request(`/api/v1/projects/${projectId}/pending-mounts/${OPERATION}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(runtime.abandoned).toEqual([
      { projectId, operationId: OPERATION, reason: "abandoned by the studio" },
    ]);

    const raced = fixture({ abandonFails: true });
    const lost = await raced.request(`/api/v1/projects/${projectId}/pending-mounts/${OPERATION}`, { method: "DELETE" });
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ error: { code: ErrorCode.WriteConflict } });
  });
});
