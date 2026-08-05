import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startVidcomFoundation } from "@vidcom/cli";
import {
  InstallMotionLibraryOutputSchema,
  LegacyGenerateResponseSchema,
  LegacyTtsResponseSchema,
  PatchPreviewSettingsResponseSchema,
  PatchSceneScriptResponseSchema,
  PatchSceneTimingResponseSchema,
  PutProjectFileResponseSchema,
  StudioSnapshotResponseSchema,
  UploadBgmResponseSchema,
  type ProjectId,
} from "@vidcom/contracts";
import { createServerApp, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";
import { afterEach, describe, expect, it } from "vitest";

import { createSequentialIdPort } from "../support/deterministic";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Phase N write cutover", () => {
  it("locks v1 writes and legacy tts/generate shapes through Hono and WriteAuthority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-write-cutover-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await cp(path.resolve("projects/warm-grain"), path.join(workspace, "warm-grain"), { recursive: true });
    const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
    const foundation = await startVidcomFoundation({
      appDataRoot: path.join(root, "app-data"),
      workspaceRoot: workspace as never,
      holderId: "test:write-cutover",
      clock,
      ids: createSequentialIdPort(),
    }, {
      async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
    });
    const nonces = new InMemoryNonceStore(clock);
    const sessions = new InMemorySessionStore(clock);
    const port = 43212;
    const projectReads = {
      ...foundation.application.readDependencies,
      runtimeSource: foundation.infrastructure.runtimeSource,
      mimeFromPath: foundation.infrastructure.mimeFromPath,
    };
    const app = createServerApp({
      port, uiOrigins: [], nonces, sessions, projectReads,
      projectWrites: { ...foundation.application.writeDependencies, reads: foundation.application.readDependencies },
    });
    const base = async (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Host", `127.0.0.1:${port}`);
      return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
    };
    const exchange = await base("/api/v1/auth/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: nonces.issue() }),
    });
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const request = (pathname: string, init: RequestInit = {}) => base(pathname, {
      ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Cookie: cookie },
    });
    try {
      const projects = await foundation.infrastructure.workspace.listProjects();
      const id = projects[0]!.id as ProjectId;
      const snapshotResponse = await request(`/api/v1/projects/${id}/studio-snapshot`);
      const snapshot = StudioSnapshotResponseSchema.parse(await snapshotResponse.json());
      const nextContent = `${snapshot.entryFile.content}\n<!-- phase-n -->\n`;
      const put = await request(`/api/v1/projects/${id}/files`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: snapshot.entryFile.path, content: nextContent, expectedContentHash: snapshot.entryFile.contentHash }),
      });
      const saved = PutProjectFileResponseSchema.parse(await put.json());
      expect(saved.file.content).toContain("phase-n");

      const stale = await request(`/api/v1/projects/${id}/files`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: snapshot.entryFile.path, content: nextContent, expectedContentHash: snapshot.entryFile.contentHash }),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ current: { contentHash: saved.file.contentHash } });
      const legacyVersion = await request(`/api/v1/projects/${id}/files`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: snapshot.entryFile.path, content: "legacy", expectedContentHash: "abc-12" }),
      });
      expect(legacyVersion.status).toBe(400);
      expect(await legacyVersion.json()).toMatchObject({ error: { code: "version_format_legacy" } });
      const executableAsset = await request(`/api/v1/projects/${id}/files`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "assets/payload.exe", content: "MZ", expectedContentHash: null }),
      });
      expect(executableAsset.status).toBe(403);
      expect(await executableAsset.json()).toMatchObject({ error: { code: "asset_not_allowed" } });

      const patch = await request(`/api/v1/projects/${id}/preview-settings`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { bgm: { volume: 0.4 } }, expectedRevision: snapshot.previewSettingsRevision }),
      });
      const patched = PatchPreviewSettingsResponseSchema.parse(await patch.json());
      const form = new FormData();
      form.append("file", new File([new Uint8Array([0x49, 0x44, 0x33, 1])], "phase-n.mp3", { type: "audio/mpeg" }));
      form.append("expectedRevision", String(patched.revision));
      const upload = await request(`/api/v1/projects/${id}/assets/bgm`, { method: "POST", body: form });
      const uploaded = UploadBgmResponseSchema.parse(await upload.json());
      expect(uploaded.previewSettings.bgm.track?.path).toBe("preview-assets/bgm/phase-n.mp3");
      const duplicate = await request(`/api/v1/projects/${id}/assets/bgm`, { method: "POST", body: form });
      expect(duplicate.status).toBe(409);

      const scene = snapshot.scenes.find((item) => !item.isTransition)!;
      const timing = await request(`/api/v1/projects/${id}/scenes/${scene.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timing: { start: scene.start, duration: scene.duration, trackIndex: scene.trackIndex },
          expectedContentHash: saved.file.contentHash,
        }),
      });
      const timed = PatchSceneTimingResponseSchema.parse(await timing.json());
      const line = scene.script[0];
      if (line) {
        const source = await request(`/api/v1/projects/${id}/files?path=${encodeURIComponent(line.file)}`);
        const sourceBody = await source.json() as { file: { contentHash: string } };
        const script = await request(`/api/v1/projects/${id}/scenes/${scene.id}/script`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: line.file, elementId: line.id, text: line.text, expectedContentHash: sourceBody.file.contentHash }),
        });
        PatchSceneScriptResponseSchema.parse(await script.json());
      }
      expect(timed.file.contentHash).toMatch(/^sha256:/);

      const tts = await request("/api/hf/warm-grain/scene", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tts", sceneId: scene.id, text: "Narration phase N" }),
      });
      expect(LegacyTtsResponseSchema.parse(await tts.json()).narration.status).toBe("mock");
      const generate = await request("/api/hf/warm-grain/scene", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", prompt: "A concise closing scene" }),
      });
      expect(LegacyGenerateResponseSchema.parse(await generate.json()).transcript.length).toBeGreaterThan(0);
    } finally {
      await foundation.stop();
    }
  });

  it("vendors a motion library through the same write authority the studio UI calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-motion-route-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await cp(path.resolve("projects/warm-grain"), path.join(workspace, "warm-grain"), { recursive: true });
    const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
    const foundation = await startVidcomFoundation({
      appDataRoot: path.join(root, "app-data"),
      workspaceRoot: workspace as never,
      holderId: "test:motion-route",
      clock,
      ids: createSequentialIdPort(),
    }, {
      async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
    });
    const nonces = new InMemoryNonceStore(clock);
    const sessions = new InMemorySessionStore(clock);
    const port = 43213;
    const app = createServerApp({
      port,
      uiOrigins: [],
      nonces,
      sessions,
      projectReads: {
        ...foundation.application.readDependencies,
        runtimeSource: foundation.infrastructure.runtimeSource,
        mimeFromPath: foundation.infrastructure.mimeFromPath,
      },
      projectWrites: { ...foundation.application.writeDependencies, reads: foundation.application.readDependencies },
    });
    const base = async (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Host", `127.0.0.1:${port}`);
      return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
    };
    const exchange = await base("/api/v1/auth/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: nonces.issue() }),
    });
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    let projectId = "" as ProjectId;
    const install = (libraryId: string) => base(`/api/v1/projects/${projectId}/motion-libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ libraryId }),
    });
    try {
      projectId = (await foundation.infrastructure.workspace.listProjects())[0]!.id as ProjectId;

      // warm-grain already ships the vendored GSAP, so the first call must cost
      // no revision — the UI can offer it without risking a pointless write.
      const already = await install("gsap");
      expect(already.status).toBe(200);
      expect(await already.json()).toMatchObject({
        status: "already_installed",
        library: { id: "gsap", loader: "global", globalName: "gsap", importSpecifier: null },
        revision: null,
      });

      const three = await install("three");
      expect(three.status).toBe(200);
      const body = InstallMotionLibraryOutputSchema.parse(await three.json());
      expect(body.status).toBe("installed");
      expect(body.library.importSpecifier).toBe(`./${body.library.entry}`);
      expect(body.files).toHaveLength(2);
      expect(typeof body.revision).toBe("number");
      for (const file of body.files) {
        // Both halves must be readable back through the asset route, or the
        // module's sibling import 404s in preview.
        const served = await base(`/api/v1/projects/${projectId}/assets/${file.path}`, {
          headers: { Cookie: cookie },
        });
        expect(served.status, file.path).toBe(200);
        expect(Number(served.headers.get("content-length") ?? "0")).toBeGreaterThan(1_000);
      }

      const repeat = await install("three");
      expect(await repeat.json()).toMatchObject({ status: "already_installed", revision: null });

      const rejected = await install("matter-js");
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: "schema_invalid" } });
    } finally {
      await foundation.stop();
    }
  });
});
