import { createHash } from "node:crypto";

import { mimeFromPath } from "@vidcom/adapter";
import {
  ErrorResponseSchema,
  ErrorCode,
  ListProjectsResponseSchema,
  StudioSnapshotResponseSchema,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  ok,
  type AbsolutePath,
  type CompositionDocumentOptions,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";
import {
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
} from "@vidcom/server";
import { describe, expect, it } from "vitest";

const id = "project-alpha" as ProjectId;
const ref: ProjectRef = {
  id,
  slug: "alpha",
  root: "/private/workspace/alpha" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const contentHash = (value: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as ContentHash;

function fixture() {
  const port = 43210;
  const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
  const nonces = new InMemoryNonceStore(clock);
  const sessions = new InMemorySessionStore(clock);
  const files = new Map<string, string>([
    ["index.html", '<main data-composition-id="root" data-duration="4">hello</main>'],
    ["preview-settings.json", `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS)}\n`],
  ]);
  const assets = new Map<string, Uint8Array>([
    ["assets/pixel.png", new Uint8Array([1, 2, 3, 4])],
  ]);
  const project = {
    id,
    slug: "alpha",
    title: "Alpha",
    width: 1920,
    height: 1080,
    duration: 4,
    updatedAt: "2026-08-01T00:00:00.000Z",
    sceneCount: 1,
    revision: 3,
  };
  const projectReads = {
    workspace: {
      async resolve(_ref: ProjectRef, path: string) { return ok(path as ResolvedPath); },
      async resolveWorkspace() { throw new Error("unused"); },
      async listProjects() { return [ref]; },
      async readProjectRef(projectId: ProjectId) { return projectId === id ? ref : null; },
      async readFile(path: ResolvedPath) {
        const content = files.get(path);
        return content === undefined ? null : { content, contentHash: contentHash(content) };
      },
      async readBytes(path: ResolvedPath) {
        const bytes = assets.get(path);
        return bytes ? { bytes, contentHash: contentHash(bytes) } : null;
      },
      async readHash() { return null; },
      async writeAtomic() {},
      async exists(path: ResolvedPath) { return files.has(path) || assets.has(path); },
      async deleteAtomic(path: ResolvedPath) { files.delete(path); assets.delete(path); },
      async captureForMutation() { throw new Error("unused"); },
      async publishCaptured() { throw new Error("unused"); },
      async restoreCaptured() { throw new Error("unused"); },
      async discardCapture() {},
      async readTree() { return [{ path: "index.html" as RelPath, name: "index.html", kind: "file" as const }]; },
      async stat() { return null; },
      async readDirectory() { return []; },
    },
    composition: {
      async parseProject() {
        return {
          project,
          scenes: [{
            id: "scene-1", src: null, start: 0, duration: 4, trackIndex: 1,
            block: null, isTransition: false, media: [], script: [], narration: null,
            elements: [], unresolvedEffects: 0,
          }],
          rootTrack: null,
          diagnostics: [],
          sources: [{ path: "index.html" as RelPath, contentHash: contentHash("entry"), byteSize: 5 }],
          references: [],
        };
      },
      async buildDocument(
        _ref: ProjectRef,
        _settings: typeof DEFAULT_PREVIEW_SETTINGS,
        options: CompositionDocumentOptions,
      ) {
        return `<html data-mode="${options.mode}" data-revision="${options.mode === "preview" ? options.projectRevision : ""}" data-seq="${options.mode === "preview" ? options.changeSeq : ""}" data-runtime="${options.runtimeUrl}" data-files="${options.fileBaseUrl}"></html>`;
      },
      async applyOps() { return ok("unused"); },
    },
    journal: {
      async begin() { return 1 as never; }, async commit() { return 1; }, async abort() {},
      async listPending() { return []; }, async latestRevision() { return 3; }, async latestSourceRevision() { return 3; },
      async readRevisionRollbackPayload() {
        return { ok: false as const, error: { code: ErrorCode.NotFound, message: "unused" } };
      },
      async readEntityState() {
        return { revision: 2, contentHash: contentHash(files.get("preview-settings.json")!), backingPath: "preview-settings.json" as RelPath };
      },
      async findProjectRegistration() { return null; }, async registerProject() {},
      async beginBootstrap() { return 1 as never; }, async recover() { return 1; }, async orphan() {},
      async readProjectRecoveryStatus() { return { writeStatus: "ready" as const, unresolved: [] }; },
    },
    events: { async latestProjectSeq() { return 8; } },
    runtimeSource: () => "globalThis.Hyperframes = {};",
    mimeFromPath,
  };
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces,
    sessions,
    projectReads,
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
  return { request, authenticate };
}

describe("project read routing contracts", () => {
  it("serves v1 and legacy runtime from the same dependency", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    const current = await request("/api/v1/runtime", { headers: { Cookie: cookie } });
    const legacy = await request("/api/hf/runtime", { headers: { Cookie: cookie } });
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(await legacy.text());
    expect(current.headers.get("content-type")).toContain("text/javascript");
  });

  it("returns contract-valid project list and one-request studio snapshot", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    const projects = await request("/api/v1/projects", { headers: { Cookie: cookie } });
    expect(ListProjectsResponseSchema.parse(await projects.json()).projects[0]?.id).toBe(id);
    const snapshot = await request(`/api/v1/projects/${id}/studio-snapshot`, { headers: { Cookie: cookie } });
    expect(StudioSnapshotResponseSchema.parse(await snapshot.json())).toMatchObject({
      project: { id, slug: "alpha" },
      entryFile: { path: "index.html" },
      revision: 3,
    });
  });

  it("serves source and preview-settings reads through their Core use cases", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    const source = await request(`/api/v1/projects/${id}/files?path=index.html`, { headers: { Cookie: cookie } });
    expect(await source.json()).toMatchObject({ file: { path: "index.html", content: expect.stringContaining("hello") } });
    const settings = await request(`/api/v1/projects/${id}/preview-settings`, { headers: { Cookie: cookie } });
    expect(await settings.json()).toMatchObject({ previewSettings: DEFAULT_PREVIEW_SETTINGS, revision: 2 });
  });

  it("keeps legacy preview shape while v1 uses new runtime and asset URLs", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    const current = await request(`/api/v1/projects/${id}/preview`, { headers: { Cookie: cookie } });
    const legacy = await request("/api/hf/alpha/preview", { headers: { Cookie: cookie } });
    expect(await current.text()).toContain(`/api/v1/projects/${id}/assets/`);
    expect(await (await request(`/api/v1/projects/${id}/preview`, { headers: { Cookie: cookie } })).text())
      .toContain('data-mode="preview" data-revision="3" data-seq="8"');
    expect(await legacy.text()).toContain("/api/hf/alpha/files/");
    expect(current.headers.get("cache-control")).toBe("no-store");
    expect(current.headers.get("x-vidcom-project-revision")).toBe("3");
    expect(current.headers.get("x-vidcom-change-seq")).toBe("8");
    expect(legacy.headers.get("x-vidcom-project-revision")).toBe("3");
    expect(legacy.headers.get("x-vidcom-change-seq")).toBe("8");
    expect(legacy.status).toBe(200);
  });

  it("locks asset MIME, bytes, cache and legacy range behavior", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    const current = await request(`/api/v1/projects/${id}/assets/assets/pixel.png`, { headers: { Cookie: cookie } });
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await current.arrayBuffer())]).toEqual([1, 2, 3, 4]);

    const ranged = await request("/api/hf/alpha/files/assets/pixel.png", {
      headers: { Cookie: cookie, Range: "bytes=1-2" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 1-2/4");
    expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([2, 3]);

    const rejected = await request(`/api/v1/projects/${id}/assets/assets/secret.exe`, { headers: { Cookie: cookie } });
    expect(rejected.status).toBe(403);
    expect(ErrorResponseSchema.parse(await rejected.json()).error.code).toBe("asset_not_allowed");
  });

  it("never exposes an absolute project path in errors", async () => {
    const { request, authenticate } = fixture();
    const cookie = await authenticate();
    const response = await request("/api/v1/projects/missing/studio-snapshot", { headers: { Cookie: cookie } });
    const raw = await response.text();
    expect(response.status).toBe(404);
    expect(raw).not.toContain("/private/workspace");
    expect(ErrorResponseSchema.parse(JSON.parse(raw)).error.code).toBe("project_not_found");
  });
});
