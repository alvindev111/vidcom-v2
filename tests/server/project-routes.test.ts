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
  type MutationPathLease,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";
import {
  createServerApp,
  InMemoryNonceStore,
  InMemoryPreviewCapabilityStore,
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

function fixture(initialProjectChangeSeq = 8) {
  const port = 43210;
  const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
  const nonces = new InMemoryNonceStore(clock);
  const sessions = new InMemorySessionStore(clock);
  const previewCapabilities = new InMemoryPreviewCapabilityStore(clock, () => Buffer.alloc(32, 9));
  const files = new Map<string, string>([
    ["index.html", '<main data-composition-id="root" data-duration="4">hello</main>'],
    ["preview-settings.json", `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS)}\n`],
  ]);
  const assets = new Map<string, Uint8Array>([
    ["assets/pixel.png", new Uint8Array([1, 2, 3, 4])],
  ]);
  const assetIo = {
    fullReads: 0,
    opens: [] as Array<{ start: number; end: number }>,
  };
  let projectRevision = 3;
  const projectChangeSequences = new Map<ProjectId, number>([[id, initialProjectChangeSeq]]);
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
      async resolveMutation(ref: ProjectRef, path: string) {
        return ok({
          target: path as ResolvedPath,
          canonicalRoot: ref.root as unknown as ResolvedPath,
          parents: [],
        });
      },
      async revalidateMutationPath() { return true; },
      async refreshMutationPath(lease: MutationPathLease) { return lease; },
      async resolveWorkspace() { throw new Error("unused"); },
      async listProjects() { return [ref]; },
      async readProjectRef(projectId: ProjectId) { return projectId === id ? ref : null; },
      async readFile(path: ResolvedPath) {
        const content = files.get(path);
        return content === undefined ? null : { content, contentHash: contentHash(content) };
      },
      async readBytes(path: ResolvedPath) {
        assetIo.fullReads += 1;
        const bytes = assets.get(path);
        return bytes ? { bytes, contentHash: contentHash(bytes) } : null;
      },
      async statAsset(path: ResolvedPath) {
        const bytes = assets.get(path);
        if (!bytes) return null;
        return {
          size: bytes.byteLength,
          etag: `W/\"${bytes.byteLength}\"`,
          identity: {
            device: "fake",
            inode: String(path),
            size: bytes.byteLength,
            modifiedAtNs: "1",
            changedAtNs: "1",
          },
        };
      },
      async openAssetRange(path: ResolvedPath, input: { start: number; end: number }) {
        const source = assets.get(path);
        if (!source) return null;
        assetIo.opens.push({ start: input.start, end: input.end });
        const body = source.slice(input.start, input.end + 1);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        });
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
        return `<html data-mode="${options.mode}" data-revision="${options.mode === "preview" ? options.projectRevision : ""}" data-seq="${options.mode === "preview" ? options.changeSeq : ""}" data-runtime="${options.runtimeUrl}" data-files="${options.fileBaseUrl}">${files.get("index.html")}</html>`;
      },
      async applyOps() { return ok("unused"); },
    },
    journal: {
      async begin() { return 1 as never; }, async commit() { return 1; }, async abort() {},
      async listPending() { return []; }, async latestRevision() { return projectRevision; }, async latestSourceRevision() { return projectRevision; },
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
    events: { async latestProjectSeq(projectId: ProjectId) { return projectChangeSequences.get(projectId) ?? 0; } },
    runtimeSource: () => "globalThis.Hyperframes = {};",
    motionLibrarySource: async () => "globalThis.gsap = {};",
    mimeFromPath,
  };
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces,
    sessions,
    previewCapabilities,
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
  const previewRequest = async (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `preview.localhost:${port}`);
    return app.request(`http://preview.localhost:${port}${pathname}`, { ...init, headers });
  };
  const mutatePreview = (content: string, revision: number, sequence: number) => {
    files.set("index.html", content);
    projectRevision = revision;
    projectChangeSequences.set(id, sequence);
  };
  const setProjectChangeSeq = (projectId: ProjectId, sequence: number) => {
    projectChangeSequences.set(projectId, sequence);
  };
  return { request, previewRequest, previewCapabilities, authenticate, mutatePreview, setProjectChangeSeq, assetIo };
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
      frameRate: 30,
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

  it("serves document, runtime and allowlisted assets only through one project capability", async () => {
    const { request, previewRequest, previewCapabilities } = fixture();
    const { token } = previewCapabilities.mint({
      projectId: id,
      browserSessionId: "browser:test",
      studioSessionId: "01K34H7G9F0M7JQF1D91V8KY0A",
    });
    const document = await previewRequest(
      `/api/preview/v1/c/${encodeURIComponent(token)}/projects/${id}/preview`,
    );
    expect(document.status).toBe(200);
    expect(document.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(document.headers.get("content-security-policy")).toContain("form-action 'none'");
    const html = await document.text();
    const capabilityPath = `/api/preview/v1/c/${token}/projects/${id}`;
    expect(html).toContain(`${capabilityPath}/runtime`);
    expect(html).toContain(`${capabilityPath}/assets/`);

    const runtime = await previewRequest(`${capabilityPath}/runtime`);
    expect(runtime.status).toBe(200);
    const vendor = await previewRequest(`${capabilityPath}/vendor/gsap.js`);
    expect(await vendor.text()).toBe("globalThis.gsap = {};");
    const asset = await previewRequest(`${capabilityPath}/assets/assets/pixel.png`);
    expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([1, 2, 3, 4]);

    const uiOrigin = await request(`${capabilityPath}/runtime`);
    expect(uiOrigin.status).toBe(403);
  });

  it("returns fresh content and identity for the identical no-store preview URL", async () => {
    const { request, authenticate, mutatePreview } = fixture();
    const cookie = await authenticate();
    const url = `/api/v1/projects/${id}/preview`;
    const first = await request(url, { headers: { Cookie: cookie } });
    const firstBody = await first.text();

    mutatePreview('<main data-composition-id="root" data-duration="4">new body</main>', 4, 9);
    const second = await request(url, { headers: { Cookie: cookie } });
    const secondBody = await second.text();

    expect(secondBody).not.toBe(firstBody);
    expect(secondBody).toContain("new body");
    expect(secondBody).toContain('data-revision="4" data-seq="9"');
    expect(second.headers.get("cache-control")).toBe("no-store");
    expect(second.headers.get("x-vidcom-change-seq")).toBe("9");
  });

  it("keeps a project without events at sequence zero when another project advances", async () => {
    const { request, authenticate, setProjectChangeSeq } = fixture(0);
    const cookie = await authenticate();

    setProjectChangeSeq("project-beta" as ProjectId, 99);
    const response = await request(`/api/v1/projects/${id}/preview`, { headers: { Cookie: cookie } });
    const body = await response.text();

    expect(body).toContain('data-seq="0"');
    expect(response.headers.get("x-vidcom-change-seq")).toBe("0");
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

  it.each([
    ["bytes=0-0", [1], "bytes 0-0/4", { start: 0, end: 0 }],
    ["bytes=-2", [3, 4], "bytes 2-3/4", { start: 2, end: 3 }],
    ["bytes=1-2", [2, 3], "bytes 1-2/4", { start: 1, end: 2 }],
    ["bytes=2-", [3, 4], "bytes 2-3/4", { start: 2, end: 3 }],
    ["bytes=-99", [1, 2, 3, 4], "bytes 0-3/4", { start: 0, end: 3 }],
  ])("streams valid asset range %s with exact headers", async (range, body, contentRange, openedRange) => {
    const { request, authenticate, assetIo } = fixture();
    const cookie = await authenticate();
    const response = await request(`/api/v1/projects/${id}/assets/assets/pixel.png`, {
      headers: { Cookie: cookie, Range: range },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(body);
    expect(assetIo).toEqual({ fullReads: 0, opens: [openedRange] });
  });

  it.each([
    "bytes=-",
    "bytes=-0",
    "bytes=4-",
    "bytes=2-1",
    "bytes=0-1,2-3",
    "items=0-1",
    "bytes=9007199254740992-",
    "bytes=0-9007199254740992",
  ])("returns 416 without opening bytes for invalid asset range %s", async (range) => {
    const { request, authenticate, assetIo } = fixture();
    const cookie = await authenticate();
    const response = await request(`/api/v1/projects/${id}/assets/assets/pixel.png`, {
      headers: { Cookie: cookie, Range: range },
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-length")).toBe("0");
    expect(response.headers.get("content-range")).toBe("bytes */4");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(assetIo).toEqual({ fullReads: 0, opens: [] });
  });

  it("uses weak ETags for revalidation and never treats one as a valid If-Range validator", async () => {
    const { request, authenticate, assetIo } = fixture();
    const cookie = await authenticate();
    const url = `/api/v1/projects/${id}/assets/assets/pixel.png`;
    const initial = await request(url, { headers: { Cookie: cookie } });
    const etag = initial.headers.get("etag");
    expect(etag).toBe('W/"4"');
    expect((await initial.arrayBuffer()).byteLength).toBe(4);

    const unchanged = await request(url, {
      headers: { Cookie: cookie, "If-None-Match": `"other", ${etag}` },
    });
    expect(unchanged.status).toBe(304);

    const ifRange = await request(url, {
      headers: { Cookie: cookie, Range: "bytes=1-2", "If-Range": etag! },
    });
    expect(ifRange.status).toBe(200);
    expect(ifRange.headers.get("content-range")).toBeNull();
    expect([...new Uint8Array(await ifRange.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(assetIo).toEqual({
      fullReads: 0,
      opens: [{ start: 0, end: 3 }, { start: 0, end: 3 }],
    });
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
