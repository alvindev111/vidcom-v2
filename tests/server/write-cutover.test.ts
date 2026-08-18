import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hashContent, startVidcomFoundation } from "@vidcom/cli";
import {
  findBgmBed,
  InstallBgmOutputSchema,
  InstallMotionLibraryOutputSchema,
  LegacyGenerateResponseSchema,
  LegacyTtsResponseSchema,
  PatchPreviewSettingsResponseSchema,
  PatchSceneScriptResponseSchema,
  PatchSceneTimingResponseSchema,
  PutProjectFileResponseSchema,
  SearchBgmOutputSchema,
  StudioSnapshotResponseSchema,
  UploadBgmResponseSchema,
  type BgmProviderTrack,
  type ProjectId,
} from "@vidcom/contracts";
import { ok } from "@vidcom/core";
import { createServerApp, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";
import { afterEach, describe, expect, it } from "vitest";

import { createSequentialIdPort } from "../support/deterministic";
import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Phase N write cutover", () => {
  it("locks v1 writes and legacy tts/generate shapes through Hono and WriteAuthority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-write-cutover-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await writeSampleProject(workspace, { slug: "warm-grain", id: "project_warm_grain" });
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
    const remoteTrack: BgmProviderTrack = {
      providerId: "route-music",
      trackId: "calm-1",
      title: "Calm route score",
      creator: "Route Composer",
      durationSeconds: 5,
      extension: "wav",
      license: {
        kind: "cc-by",
        holder: "Route Composer",
        url: "https://example.test/licenses/by",
        note: null,
      },
      sourceUrl: "https://example.test/tracks/calm-1",
      attribution: "Calm route score by Route Composer, CC BY.",
      tags: ["calm", "instrumental"],
    };
    const remoteBytes = foundation.infrastructure.bgmSynth.render(findBgmBed("ambient")!, 5);
    const bgmProviders = {
      async search() {
        return {
          tracks: [remoteTrack],
          providers: [{ providerId: "route-music", status: "ok" as const, resultCount: 1, message: null }],
        };
      },
      async download(ref: { providerId: string; trackId: string }) {
        expect(ref).toEqual({ providerId: "route-music", trackId: "calm-1" });
        return ok({ track: remoteTrack, bytes: remoteBytes });
      },
    };
    const projectReads = {
      ...foundation.application.readDependencies,
      runtimeSource: foundation.infrastructure.runtimeSource,
      mimeFromPath: foundation.infrastructure.mimeFromPath,
    };
    const app = createServerApp({
      port, uiOrigins: [], nonces, sessions, projectReads,
      projectWrites: {
        ...foundation.application.writeDependencies,
        reads: foundation.application.readDependencies,
        bgmSynth: foundation.infrastructure.bgmSynth,
        bgmLibrary: foundation.infrastructure.bgmLibrary,
        bgmProviders,
        approvals: foundation.infrastructure.approvalRequests,
        hashContent,
        mimeFromPath: foundation.infrastructure.mimeFromPath,
      },
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
      const searchedResponse = await request("/api/v1/bgm/search?mood=calm%20focused&limit=4");
      expect(searchedResponse.status).toBe(200);
      expect(SearchBgmOutputSchema.parse(await searchedResponse.json())).toMatchObject({
        tracks: [{ providerId: "route-music", trackId: "calm-1" }],
        offlineFallbackAvailable: true,
      });
      const installResponse = await request(`/api/v1/projects/${id}/bgm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerTrack: { providerId: "route-music", trackId: "calm-1" },
          expectedRevision: patched.revision,
        }),
      });
      expect(installResponse.status).toBe(200);
      const installed = InstallBgmOutputSchema.parse(await installResponse.json());
      expect(installed.track.path).toMatch(/^preview-assets\/bgm\/bgm_.+\.wav$/u);
      expect(await foundation.infrastructure.bgmLibrary.list()).toEqual([
        expect.objectContaining({
          source: "provider",
          provenance: expect.objectContaining({ providerId: "route-music", trackId: "calm-1" }),
        }),
      ]);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([0x49, 0x44, 0x33, 1])], "phase-n.mp3", { type: "audio/mpeg" }));
      form.append("expectedRevision", String(installed.revision));
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
    await writeSampleProject(workspace, { slug: "warm-grain", id: "project_warm_grain" });
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
      projectWrites: {
        ...foundation.application.writeDependencies,
        reads: foundation.application.readDependencies,
        bgmSynth: foundation.infrastructure.bgmSynth,
        bgmLibrary: foundation.infrastructure.bgmLibrary,
        approvals: foundation.infrastructure.approvalRequests,
        hashContent,
        mimeFromPath: foundation.infrastructure.mimeFromPath,
      },
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

      // The sample project ships no vendored library, so the first install writes
      // and the second must cost no revision — the UI can offer it repeatedly
      // without risking a pointless write.
      const first = await install("gsap");
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        status: "installed",
        library: { id: "gsap", loader: "global", globalName: "gsap", importSpecifier: null },
      });
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
