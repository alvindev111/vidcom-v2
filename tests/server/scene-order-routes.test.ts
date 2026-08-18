// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DeleteScenesResponseSchema,
  ErrorCode,
  PrepareDeleteScenesResponseSchema,
  SceneOrderMutationResponseSchema,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  ok,
  serializePreviewSettings,
  type AbsolutePath,
  type CompositeRequest,
  type ProjectRef,
  type ResolvedPath,
  type UndoContentPort,
} from "@vidcom/core";
import {
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  MutationHistory,
  SESSION_COOKIE,
} from "@vidcom/server";

const port = 43140;
const projectId = "project_scene_order_routes" as ProjectId;
const studioId = "01K1ABCDEFGHJKMNPQRSTVWXYZ";
const ref: ProjectRef = {
  id: projectId,
  slug: "scene-order-routes",
  root: "/workspace/scene-order-routes" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
const entry = "entry";

function fixture() {
  const clock = { now: () => new Date("2026-08-18T00:00:00.000Z") };
  const sessions = new InMemorySessionStore(clock, () => Buffer.alloc(32, 6));
  const { token } = sessions.mint({ absoluteTtlMs: 60_000, idleTtlMs: 60_000 });
  const browserId = sessions.fingerprint(token)!;
  const content: UndoContentPort = {
    async retainBytes() { throw new Error("unused"); },
    async retainFile() { throw new Error("unused"); },
    async resolve() { throw new Error("unused"); },
    release() {},
  };
  const history = new MutationHistory(content, { operationId: () => "operation-route" });
  const settings = serializePreviewSettings({
    ...DEFAULT_PREVIEW_SETTINGS,
    scenes: { a: { transitionSound: "minimal", revealSound: "ping", hidden: false } },
  });
  const files = new Map<string, string>([["index.html", entry], ["preview-settings.json", settings]]);
  const requests: CompositeRequest[] = [];
  const approvals: Array<{ binding: unknown; summary: string }> = [];
  const approvalsIssued: string[] = [];
  const workspace = {
    async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; },
    async resolve(_ref: ProjectRef, path: RelPath) { return ok(path as unknown as ResolvedPath); },
    async readFile(path: ResolvedPath) {
      const value = files.get(path);
      return value === undefined ? null : { content: value, contentHash: hash(value) };
    },
    async readHash() { return null; },
    async listProjects() { return [ref]; },
    async stat() { return null; },
  };
  const composition = {
    async parseProject() {
      return {
        project: {
          id: projectId,
          slug: "scene-order-routes",
          title: "Order",
          width: 1920,
          height: 1080,
          duration: 20,
          updatedAt: "2026-08-18T00:00:00.000Z",
          sceneCount: 3,
          revision: 7,
        },
        scenes: [
          { id: "a", src: null, start: 2, duration: 3, trackIndex: 1, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
          { id: "b", src: null, start: 7, duration: 2, trackIndex: 1, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
          { id: "c", src: null, start: 12, duration: 4, trackIndex: 2, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
        ],
        rootTrack: null,
        diagnostics: [],
        sources: [{ path: "index.html" as RelPath, contentHash: hash(entry), byteSize: entry.length }],
        references: [],
      };
    },
    async applyOps() { return ok("updated entry"); },
  };
  const journal = {
    async latestRevision() { return 7; },
    async latestSourceRevision() { return 7; },
    async readEntityState() {
      return { revision: 2, contentHash: hash(settings), backingPath: "preview-settings.json" as RelPath };
    },
    async readProjectRecoveryStatus() { return { writeStatus: "ready" as const, unresolved: [] }; },
  };
  const authority = {
    async mutateSource(request: CompositeRequest) {
      requests.push(request);
      return ok({
        projectRevision: 8,
        entityRevision: request.steps.some((step) => step.kind === "entity") ? 3 : null,
        fileHashes: { "index.html": hash("updated entry") },
        diagnostics: request.diagnostics ?? [],
        changeSeq: 8,
        ...(request.backup ? { backupId: "backup_group" } : {}),
      });
    },
  };
  const projectWrites = {
    workspace,
    composition,
    journal,
    authority,
    clock,
    reads: { workspace, composition, journal },
    approvals: {
      async request(binding: unknown, summary: string) {
        approvals.push({ binding, summary });
        return "grant_group";
      },
      async issue(grantId: string) {
        approvalsIssued.push(grantId);
        return ok(grantId);
      },
    },
    hashContent: hash,
  };
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces: new InMemoryNonceStore(clock),
    sessions,
    history,
    browserSessionId: () => browserId,
    projectWrites: projectWrites as never,
  });
  const request = (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    headers.set("Cookie", `${SESSION_COOKIE}=${token}`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  const attach = () => request(`/api/v1/projects/${projectId}/history/session`, {
    method: "POST",
    headers: { "x-vidcom-studio-session": studioId },
  });
  return { request, attach, requests, approvals, approvalsIssued };
}

const jsonHeaders = {
  "Content-Type": "application/json",
  "x-vidcom-studio-session": studioId,
};

describe("scene order and group deletion routes", () => {
  it("dispatches reorder, compact and move with strict payloads and server-owned history", async () => {
    const runtime = fixture();
    expect((await runtime.attach()).status).toBe(204);
    const reorder = await runtime.request(`/api/v1/projects/${projectId}/scenes/order`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ sceneId: "b", toIndex: 0, expectedContentHash: hash(entry) }),
    });
    expect(reorder.status).toBe(200);
    expect(SceneOrderMutationResponseSchema.parse(await reorder.json())).toMatchObject({ changed: true, revision: 8 });

    const compact = await runtime.request(`/api/v1/projects/${projectId}/tracks/1/compact`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ expectedContentHash: hash(entry) }),
    });
    expect(compact.status).toBe(200);
    expect(SceneOrderMutationResponseSchema.parse(await compact.json())).toMatchObject({ changed: true, revision: 8 });

    const move = await runtime.request(`/api/v1/projects/${projectId}/scenes/move`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ sceneIds: ["a", "c"], deltaSeconds: 1, expectedContentHash: hash(entry) }),
    });
    expect(move.status).toBe(200);
    expect(SceneOrderMutationResponseSchema.parse(await move.json())).toMatchObject({ changed: true, revision: 8 });
    expect(runtime.requests).toHaveLength(3);
    expect(runtime.requests.map((request) => request.origin)).toEqual([
      expect.objectContaining({ sessionId: studioId, label: "Reorder scene", historyAction: "record" }),
      expect.objectContaining({ sessionId: studioId, label: "Compact track", historyAction: "record" }),
      expect.objectContaining({ sessionId: studioId, label: "Move 2 scenes", historyAction: "record" }),
    ]);
  });

  it("requires an attached studio session and rejects undeclared compact input", async () => {
    const runtime = fixture();
    const missing = await runtime.request(`/api/v1/projects/${projectId}/scenes/order`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneId: "a", toIndex: 0, expectedContentHash: hash(entry) }),
    });
    expect(missing.status).toBe(400);
    expect(runtime.requests).toHaveLength(0);

    await runtime.attach();
    const invalid = await runtime.request(`/api/v1/projects/${projectId}/scenes/order`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ sceneId: "a", toIndex: 0, compact: true, expectedContentHash: hash(entry) }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
    expect(runtime.requests).toHaveLength(0);

    const unchanged = await runtime.request(`/api/v1/projects/${projectId}/scenes/order`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ sceneId: "a", toIndex: 0, expectedContentHash: hash(entry) }),
    });
    expect(unchanged.status).toBe(200);
    expect(SceneOrderMutationResponseSchema.parse(await unchanged.json())).toMatchObject({
      changed: false,
      changes: [],
      revision: 7,
      changeSeq: null,
    });
    expect(runtime.requests).toHaveLength(0);
  });

  it("prepares and executes exact-intent group deletion through one route mutation", async () => {
    const runtime = fixture();
    await runtime.attach();
    const prepared = await runtime.request(`/api/v1/projects/${projectId}/scenes/deletions`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ sceneIds: ["c", "a"], expectedRevision: 7 }),
    });
    expect(prepared.status).toBe(200);
    expect(PrepareDeleteScenesResponseSchema.parse(await prepared.json())).toMatchObject({
      grantId: "grant_group",
      plan: { sceneIds: ["a", "c"] },
    });
    expect(runtime.approvals).toHaveLength(1);
    expect(runtime.requests).toHaveLength(0);

    const deleted = await runtime.request(`/api/v1/projects/${projectId}/scenes/deletions/grant_group`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ sceneIds: ["c", "a"], expectedRevision: 7 }),
    });
    expect(deleted.status).toBe(200);
    expect(DeleteScenesResponseSchema.parse(await deleted.json())).toMatchObject({
      project: { sceneCount: 1 },
      revision: 8,
      backupId: "backup_group",
    });
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.approvalsIssued).toEqual(["grant_group"]);
    expect(runtime.requests[0]).toMatchObject({
      backup: true,
      grant: { id: "grant_group", binding: { target: '["a","c"]' } },
      origin: { sessionId: studioId, label: "Delete 2 scenes", historyAction: "record" },
    });
  });
});
