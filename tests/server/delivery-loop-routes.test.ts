import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppSettingsStore, initializeDatabase } from "@vidcom/adapter";
import {
  getNextHostedRuntime,
  handleNextHostedRequest,
  hostBrowseTokens,
  HOST_BROWSE_SESSION,
  registerHostedRuntime,
  startNextHostedRuntime,
  type HostedRuntimeHost,
} from "@vidcom/cli";
import { ErrorCode, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  ok,
  type AbsolutePath,
  type DerivedMutationPath,
  type JobId,
  type ProjectIdentity,
} from "@vidcom/core";
import { createServerApp, InMemoryNonceStore, InMemorySessionStore, sessionFingerprint } from "@vidcom/server";
import { enqueueRenderJob, enqueueSnapshotJob } from "@vidcom/worker";
import { afterEach, describe, expect, it } from "vitest";

import {
  createApplication,
  createInfrastructure,
  createMcpRegistry,
  hashContent,
} from "../../packages/cli/src/composition-root";
import { createSequentialIdPort } from "../support/deterministic";

const roots: string[] = [];
const clock = { now: () => new Date("2026-08-04T18:00:00.000Z") };

function qualifiedSceneSource(sceneId: string, duration: number): string {
  return `<!doctype html><html><body><template>
    <style>#${sceneId}{width:1920px;height:1080px}</style>
    <section id="${sceneId}" data-composition-id="${sceneId}" data-width="1920" data-height="1080" data-duration="${duration}">
      <div id="hero">Opening</div>
      <script>
        const tl = gsap.timeline({ paused: true });
        tl.fromTo("#hero", { scale: 0.72 }, { scale: 1, duration: 0.6, ease: "expo.out" }, 0.2);
        tl.to("#hero", { rotation: 8, duration: 0.6, ease: "sine.inOut" }, 1.2);
        window.__timelines = window.__timelines || {};
        window.__timelines["${sceneId}"] = tl;
      </script>
    </section>
  </template></body></html>`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-delivery-http-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace") as AbsolutePath;
  const appDataRoot = path.join(root, "app-data");
  await mkdir(workspaceRoot);
  const initialized = await initializeDatabase(appDataRoot);
  await initialized.destroy();
  const infrastructure = createInfrastructure({
    appDataRoot,
    workspaceRoot,
    clock,
    ids: createSequentialIdPort(),
  });
  const lease = await infrastructure.lease.acquire(workspaceRoot, "test:http-delivery-loop");
  if (!lease.ok) throw new Error("workspace lease denied");
  const application = createApplication(infrastructure, lease.leaseId);
  const enqueueDependencies = {
    workspace: infrastructure.workspace,
    composition: infrastructure.composition,
    journal: infrastructure.journal,
    jobs: infrastructure.jobs,
    ids: infrastructure.ids,
    hashContent,
    binaries: {
      probe: async () => ok({
        hyperframesCommand: [process.execPath, "hyperframes"] as const,
        browserPath: process.execPath as AbsolutePath,
        ffmpegPath: process.execPath as AbsolutePath,
        ffprobePath: process.execPath as AbsolutePath,
        warnings: [],
      }),
    },
    fonts: application.fonts,
    diagnostics: {
      forProject: async (projectId: ProjectId) => ok({
        diagnostics: [],
        computedAtSourceRevision: await infrastructure.journal.latestSourceRevision(projectId) ?? 0,
        lintSourceAvailable: true,
      }),
    },
  };
  const port = 43219;
  const nonces = new InMemoryNonceStore(clock);
  const sessions = new InMemorySessionStore(clock);
  let activationError: ErrorCode | null = null;
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces,
    sessions,
    jobs: infrastructure.jobs,
    events: infrastructure.events,
    deliveryLoop: {
      workspaceRoot,
      workspaceOverview: async () => ({
        workspaceRoot,
        source: "explicit",
        entries: await application.scanWorkspace(),
      }),
      activateWorkspace: async () => activationError
        ? { ok: false, error: { code: activationError, message: `injected ${activationError}` } }
        : { ok: true, value: { workspaceRoot, reauthRequired: true } },
      lifecycle: application.lifecycle,
      diagnostics: application.diagnostics,
      agentKit: application.agentKit,
      writes: application.writeDependencies,
      reads: application.readDependencies,
      jobs: infrastructure.jobs,
      enqueueRender: (input) => enqueueRenderJob(enqueueDependencies, input),
      enqueueSnapshot: (input) => enqueueSnapshotJob(enqueueDependencies, input),
      replaceRecoveryIdentity: (input) => application.lifecycle.replaceIdentity({
        ...input,
        identity: input.identity as unknown as ProjectIdentity,
      }),
      mimeFromPath: infrastructure.mimeFromPath,
    },
  });
  const requestRaw = async (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  const exchanged = await requestRaw("/api/v1/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: nonces.issue() }),
  });
  const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0]!;
  const request = (pathname: string, init: RequestInit = {}) => requestRaw(pathname, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), Cookie: cookie },
  });
  return {
    root, workspaceRoot, infrastructure, application, request,
    setActivationError: (code: ErrorCode | null) => { activationError = code; },
  };
}

/**
 * Mints a selection token the way a browse would.
 *
 * The route no longer accepts a path, so the harness has to produce a real
 * token — which is why F.3 had to land before F.5. The stub activation ignores
 * the value, but the request body has to be shaped like the real one or the
 * strict schema rejects it.
 */
function mintSelection(canonicalPath: string, sessionId = HOST_BROWSE_SESSION): string {
  // Minted into the store the host actually reads. A second store would produce
  // a token the route could never redeem, which is the mistake this replaces.
  return hostBrowseTokens.mint({
    sessionId,
    canonicalPath,
    identity: { device: "1", inode: canonicalPath },
  }).token;
}

function browseSession(cookie: string): string {
  const token = cookie.split("=", 2)[1];
  if (!token) throw new Error("browser session cookie is missing its token");
  return sessionFingerprint(token);
}

describe("project delivery HTTP routes on real SQLite and filesystem", () => {
  it("maps Phase-O errors through the real middleware and route pipeline", async () => {
    const value = await fixture();
    try {
      const cases = [
        [ErrorCode.SchemaInvalid, 400], [ErrorCode.PreconditionRequired, 409],
        [ErrorCode.ProjectInvalid, 409], [ErrorCode.NoComposition, 422],
        [ErrorCode.NoScenes, 422], [ErrorCode.RemoteAssetNotLocal, 422],
        [ErrorCode.AssetNotAllowed, 403], [ErrorCode.PathOutsideProject, 403],
        [ErrorCode.RenderBinaryMissing, 503], [ErrorCode.ProcessTerminationUnverified, 500],
        [ErrorCode.ApprovalRequired, 403], [ErrorCode.ConfirmationRequired, 403],
        [ErrorCode.StorageUnavailable, 500], [ErrorCode.Internal, 500],
      ] as const;
      for (const [code, status] of cases) {
        value.setActivationError(code);
        const response = await value.request("/api/v1/workspace/active", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectionToken: mintSelection(value.workspaceRoot) }),
        });
        expect(response.status, code).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("rejects non-JSON bodies and invalid path parameters at the HTTP boundary", async () => {
    const value = await fixture();
    try {
      const wrongMedia = await value.request("/api/v1/projects", {
        method: "POST", headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ name: "Wrong media", presetId: "horizontal-youtube" }),
      });
      expect(wrongMedia.status).toBe(415);
      expect(await wrongMedia.json()).toMatchObject({ error: { code: "unsupported_media", field: "content-type" } });

      const invalid = "x".repeat(256);
      const responses = await Promise.all([
        value.request(`/api/v1/projects/${invalid}/adopt`, { method: "POST" }),
        value.request(`/api/v1/projects/${invalid}/diagnostics`),
        value.request(`/api/v1/projects/project/scenes/${invalid}/narration-cues`),
        value.request(`/api/v1/recovery/entries/${invalid}/diagnostics`),
        value.request(`/api/v1/jobs/${invalid}/termination-proof`),
        value.request(`/api/v1/projects/project/scenes/scene/narration-cues/${invalid}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offsetSeconds: 0, expectedContentHash: `sha256:${"a".repeat(64)}` }),
        }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "schema_invalid" } });
      }
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("routes project lifecycle, candidate adoption and entryId-only recovery", async () => {
    const value = await fixture();
    try {
      const candidateRoot = path.join(value.workspaceRoot, "candidate");
      await mkdir(candidateRoot);
      await writeFile(path.join(candidateRoot, "hyperframes.json"), "{}\n");
      await writeFile(path.join(candidateRoot, "index.html"),
        '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="0"></main>\n');
      const adopted = await value.request("/api/v1/projects/candidate/adopt", { method: "POST" });
      expect(adopted.status).toBe(200);
      expect(await adopted.json()).toHaveProperty("projectId");

      const created = await value.request("/api/v1/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Lifecycle", presetId: "horizontal-youtube" }),
      });
      const { projectId } = await created.json() as { projectId: ProjectId };
      const renamed = await value.request(`/api/v1/projects/${projectId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Lifecycle Renamed" }),
      });
      expect(await renamed.json()).toEqual({ slug: "lifecycle-renamed" });
      const removed = await value.request(`/api/v1/projects/${projectId}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toHaveProperty("backupId");

      const invalidRoot = path.join(value.workspaceRoot, "invalid-entry");
      await mkdir(invalidRoot);
      await writeFile(path.join(invalidRoot, "vidcom.json"), "{invalid");
      await writeFile(path.join(invalidRoot, "hyperframes.json"), "{}\n");
      const invalid = (await value.application.scanWorkspace()).find((entry) =>
        entry.kind === "project" && entry.state === "invalid" && entry.invalidKind === "identity");
      if (!invalid || !("entryId" in invalid)) throw new Error("invalid recovery entry was not scanned");
      expect((await value.request(`/api/v1/recovery/entries/${invalid.entryId}/diagnostics`)).status).toBe(200);
      const renamedRecovery = await value.request(`/api/v1/recovery/entries/${invalid.entryId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Recovered Name" }),
      });
      expect(await renamedRecovery.json()).toEqual({ slug: "recovered-name" });
      const deletedRecovery = await value.request(`/api/v1/recovery/entries/${invalid.entryId}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      expect(deletedRecovery.status).toBe(200);

      const replaceRoot = path.join(value.workspaceRoot, "replace-identity");
      await mkdir(replaceRoot);
      await writeFile(path.join(replaceRoot, "vidcom.json"), "{broken");
      await writeFile(path.join(replaceRoot, "hyperframes.json"), "{}\n");
      const replaceEntry = (await value.application.scanWorkspace()).find((entry) =>
        entry.kind === "project" && entry.slug === "replace-identity" && "entryId" in entry);
      if (!replaceEntry || !("entryId" in replaceEntry)) throw new Error("replacement entry was not scanned");
      const replacement = await value.request(`/api/v1/recovery/entries/${replaceEntry.entryId}/identity`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedContentHash: hashContent("{broken"),
          identity: {
            schemaVersion: 1, id: "project_replacement", platform: null,
            render: { defaultPresetId: "horizontal-youtube", outputDirectory: "renders" },
            narration: { defaultProviderId: null, defaultVoiceId: null },
            createdAt: clock.now().toISOString(), updatedAt: clock.now().toISOString(),
          },
        }),
      });
      expect(replacement.status).toBe(200);
      expect(JSON.parse(await readFile(path.join(replaceRoot, "vidcom.json"), "utf8"))).toMatchObject({
        id: "project_replacement", schemaVersion: 1,
      });
      expect((await value.request("/api/v1/workspace/active", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectionToken: mintSelection(value.workspaceRoot) }),
      })).status).toBe(200);
    } finally {
      await value.infrastructure.database.destroy();
    }
  }, 15_000);

  it("uses the application lifecycle, scene, narration, job and agent-kit use cases", async () => {
    const value = await fixture();
    try {
      const created = await value.request("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "HTTP Project", presetId: "horizontal-youtube" }),
      });
      expect(created.status).toBe(201);
      const { projectId } = await created.json() as { projectId: ProjectId };
      const ref = await value.infrastructure.workspace.readProjectRef(projectId);
      if (!ref) throw new Error("created project was not discoverable");
      const entry = await value.infrastructure.workspace.readWorkspaceFile!(ref.root, "index.html");
      if (!entry) throw new Error("created project entry was missing");

      const scene = await value.request(`/api/v1/projects/${projectId}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Opening", duration: 2, expectedContentHash: entry.contentHash }),
      });
      expect(scene.status).toBe(201);
      expect(await scene.json()).toMatchObject({ scene: { id: "scene-1" } });
      await writeFile(
        path.join(ref.root, "compositions", "scene-1.html"),
        qualifiedSceneSource("scene-1", 3),
        "utf8",
      );

      const afterScene = await value.infrastructure.workspace.readWorkspaceFile!(ref.root, "index.html");
      if (!afterScene) throw new Error("scene mutation did not publish the entry file");
      const registry = createMcpRegistry(value.infrastructure, value.application);
      const timed = await registry.invoke("set_scene_timing", {
        projectId,
        sceneId: "scene-1",
        duration: 3,
        ripple: false,
        extendRoot: true,
        expectedContentHash: afterScene.contentHash,
      }, {
        era: "modern",
        protocolVersion: "2025-06-18",
        credentialId: "delivery-http-test",
        requestInput: async (): Promise<never> => { throw new Error("input was not expected"); },
      });
      expect(timed).toMatchObject({ ok: true, value: { scene: { duration: 3 } } });

      const cues = await value.request(`/api/v1/projects/${projectId}/scenes/scene-1/narration-cues`);
      expect(cues.status).toBe(200);
      expect(await cues.json()).toMatchObject({ cues: [{ text: "Opening" }] });
      expect((await value.request(`/api/v1/projects/${projectId}/diagnostics`)).status).toBe(200);

      const render = await value.request(`/api/v1/projects/${projectId}/renders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "render-http-1" }),
      });
      const snapshot = await value.request(`/api/v1/projects/${projectId}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "snapshot-http-1" }),
      });
      expect(render.status).toBe(202);
      expect(snapshot.status).toBe(202);

      const agentKit = await value.request("/api/v1/agent-kit/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "install", hosts: ["codex"] }),
      });
      expect(agentKit.status).toBe(200);
      expect(await readFile(path.join(value.workspaceRoot, "AGENTS.md"), "utf8"))
        .toContain("x-vidcom-agent-kit");

      const workspace = await value.request("/api/v1/workspace");
      expect(await workspace.json()).toMatchObject({
        workspaceRoot: value.workspaceRoot,
        entries: [{ projectId, slug: "http-project" }],
      });
    } finally {
      await value.infrastructure.database.destroy();
    }
  }, 15_000);

  it("keeps HTTP and MCP set-scene-timing semantics identical on equivalent fixtures", async () => {
    const value = await fixture();
    try {
      const createFixtureProject = async (name: string) => {
        const created = await value.request("/api/v1/projects", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, presetId: "horizontal-youtube" }),
        });
        const { projectId } = await created.json() as { projectId: ProjectId };
        const ref = await value.infrastructure.workspace.readProjectRef(projectId);
        if (!ref) throw new Error("fixture project was not discoverable");
        const emptyEntry = await value.infrastructure.workspace.readWorkspaceFile!(ref.root, "index.html");
        if (!emptyEntry) throw new Error("fixture entry was missing");
        const scene = await value.request(`/api/v1/projects/${projectId}/scenes`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Opening", duration: 2, expectedContentHash: emptyEntry.contentHash }),
        });
        expect(scene.status).toBe(201);
        const entry = await value.infrastructure.workspace.readWorkspaceFile!(ref.root, "index.html");
        if (!entry) throw new Error("fixture scene entry was missing");
        return { projectId, ref, entry };
      };
      const httpProject = await createFixtureProject("HTTP Timing");
      const mcpProject = await createFixtureProject("MCP Timing");

      const httpResponse = await value.request(`/api/v1/projects/${httpProject.projectId}/scenes/scene-1/timing`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          duration: 3, ripple: false, extendRoot: true,
          expectedContentHash: httpProject.entry.contentHash,
        }),
      });
      expect(httpResponse.status).toBe(200);
      const httpResult = await httpResponse.json() as Record<string, unknown>;

      const registry = createMcpRegistry(value.infrastructure, value.application);
      const mcpResult = await registry.invoke("set_scene_timing", {
        projectId: mcpProject.projectId,
        sceneId: "scene-1",
        duration: 3,
        ripple: false,
        extendRoot: true,
        expectedContentHash: mcpProject.entry.contentHash,
      }, {
        era: "modern", protocolVersion: "2026-07-28", credentialId: "delivery-parity-test",
        requestInput: async (): Promise<never> => { throw new Error("input was not expected"); },
      });
      expect(mcpResult.ok).toBe(true);
      if (!mcpResult.ok) throw new Error(mcpResult.error.message);
      const expected = {
        scene: { id: "scene-1", duration: 3 }, affectedTrackIndex: 0, moved: [],
        envelope: { projectRevision: expect.any(Number) },
      };
      expect(httpResult).toMatchObject(expected);
      expect(mcpResult.value).toMatchObject(expected);
      const [httpEntry, mcpEntry] = await Promise.all([
        readFile(path.join(httpProject.ref.root, "index.html"), "utf8"),
        readFile(path.join(mcpProject.ref.root, "index.html"), "utf8"),
      ]);
      expect(httpEntry).toBe(mcpEntry);
      expect(await value.infrastructure.journal.latestRevision(httpProject.projectId)).toEqual(expect.any(Number));
      expect(await value.infrastructure.journal.latestRevision(mcpProject.projectId)).toEqual(expect.any(Number));
    } finally {
      await value.infrastructure.database.destroy();
    }
  }, 15_000);

  it("serves MP4 ranges/ETags, exposes termination proof, and maps readiness errors", async () => {
    const value = await fixture();
    try {
      const created = await value.application.lifecycle.create({
        name: "Artifact",
        preset: (await import("@vidcom/core")).PLATFORM_PRESETS[1]!,
      });
      if (!created.ok) throw new Error(created.error.message);
      const ref = await value.infrastructure.workspace.readProjectRef(created.value.projectId);
      if (!ref) throw new Error("project was not discoverable");
      const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
      const artifactPath = "renders/artifact.mp4" as RelPath;
      const written = await value.application.authority.mutateDerived({
        ref,
        writes: [{ path: artifactPath as DerivedMutationPath, content: bytes }],
        producedByJobId: null,
        computedAtSourceRevision: 1,
      }, "system");
      if (!written.ok) throw new Error(written.error.message);
      const jobInput = { projectId: created.value.projectId };
      const queued = await value.infrastructure.jobs.enqueue({
        id: "job_download" as JobId,
        projectId: created.value.projectId,
        type: "render",
        input: jobInput,
        inputHash: hashContent(canonicalizeJobInput(jobInput)),
        idempotencyKey: null,
      });
      if ("conflict" in queued) throw new Error("unexpected job conflict");
      await value.infrastructure.jobs.claim(queued.job.id as JobId, "worker-http");
      await value.infrastructure.jobs.finish(queued.job.id as JobId, {
        status: "succeeded",
        result: { artifactPath },
      });

      const ranged = await value.request("/api/v1/renders/job_download/download", {
        headers: { Range: "bytes=2-4" },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe("bytes 2-4/6");
      expect(ranged.headers.get("cache-control")).toBe("must-revalidate");
      expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([2, 3, 4]);
      const etag = ranged.headers.get("etag")!;
      expect((await value.request("/api/v1/renders/job_download/download", {
        headers: { "If-None-Match": etag },
      })).status).toBe(304);
      for (const header of [
        "bytes=999-1000",
        "bytes=-0",
        "bytes=4-2",
        "bytes=abc-def",
        `bytes=${"9".repeat(400)}-`,
      ]) {
        const unsatisfiable = await value.request("/api/v1/renders/job_download/download", {
          headers: { Range: header },
        });
        expect(unsatisfiable.status, header).toBe(416);
        expect(unsatisfiable.headers.get("content-range"), header).toBe("bytes */6");
        expect(unsatisfiable.headers.get("cache-control"), header).toBe("must-revalidate");
      }
      const hugeSuffix = await value.request("/api/v1/renders/job_download/download", {
        headers: { Range: `bytes=-${"9".repeat(400)}` },
      });
      expect(hugeSuffix.status).toBe(206);
      expect(hugeSuffix.headers.get("content-range")).toBe("bytes 0-5/6");

      const emptyPath = "renders/empty.mp4" as RelPath;
      const emptyWrite = await value.application.authority.mutateDerived({
        ref,
        writes: [{ path: emptyPath as DerivedMutationPath, content: new Uint8Array() }],
        producedByJobId: null,
        computedAtSourceRevision: 1,
      }, "system");
      if (!emptyWrite.ok) throw new Error(emptyWrite.error.message);
      const emptyJobInput = { projectId: created.value.projectId, empty: true };
      const emptyJob = await value.infrastructure.jobs.enqueue({
        id: "job_empty_download" as JobId,
        projectId: created.value.projectId,
        type: "render",
        input: emptyJobInput,
        inputHash: hashContent(canonicalizeJobInput(emptyJobInput)),
        idempotencyKey: null,
      });
      if ("conflict" in emptyJob) throw new Error("unexpected empty job conflict");
      await value.infrastructure.jobs.claim(emptyJob.job.id as JobId, "worker-http");
      await value.infrastructure.jobs.finish(emptyJob.job.id as JobId, {
        status: "succeeded",
        result: { artifactPath: emptyPath },
      });
      const emptyRange = await value.request("/api/v1/renders/job_empty_download/download", {
        headers: { Range: "bytes=0-0" },
      });
      expect(emptyRange.status).toBe(416);
      expect(emptyRange.headers.get("content-range")).toBe("bytes */0");

      const failedInput = { projectId: created.value.projectId, attempt: 2 };
      const failed = await value.infrastructure.jobs.enqueue({
        id: "job_proof" as JobId,
        projectId: created.value.projectId,
        type: "render",
        input: failedInput,
        inputHash: hashContent(canonicalizeJobInput(failedInput)),
        idempotencyKey: null,
      });
      if ("conflict" in failed) throw new Error("unexpected proof job conflict");
      await value.infrastructure.jobs.claim(failed.job.id as JobId, "worker-http");
      await value.infrastructure.jobs.finish(failed.job.id as JobId, {
        status: "failed",
        error: { code: ErrorCode.ProcessTerminationUnverified, message: "survivor remained" },
        terminationProof: {
          reason: "timeout",
          rootPid: 91,
          capturedPids: [91, 92],
          capturedGroups: [91],
          survivors: [92],
          exhaustive: false,
          sweeps: 3,
        },
      });
      const proof = await value.request("/api/v1/jobs/job_proof/termination-proof");
      expect(proof.status).toBe(200);
      expect(await proof.json()).toEqual({
        reason: "timeout",
        rootPid: 91,
        capturedPids: [91, 92],
        capturedGroups: [91],
        survivors: [92],
        exhaustive: false,
        sweeps: 3,
      });

      const emptyRender = await value.request(`/api/v1/projects/${created.value.projectId}/renders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "empty-render" }),
      });
      expect(emptyRender.status).toBe(422);
      expect(await emptyRender.json()).toMatchObject({ error: { code: "no_scenes" } });
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

  it("hot-swaps the selected workspace, clears recovery tokens, and preserves the host session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-workspace-swap-"));
    roots.push(root);
    const firstWorkspace = path.join(root, "workspace-one");
    const secondWorkspace = path.join(root, "workspace-two");
    const appData = path.join(root, "app-data");
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    const canonicalSecondWorkspace = await realpath(secondWorkspace);
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
      settings: process.env.VIDCOM_SETTINGS,
    };
    const nonce = Buffer.alloc(32, 9).toString("base64url");
    const port = 49331;
    const host = `127.0.0.1:${port}`;
    process.env.VIDCOM_APP_DATA = appData;
    process.env.VIDCOM_WORKSPACE = firstWorkspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    process.env.VIDCOM_SETTINGS = path.join(root, "setting.json");
    const first = await getNextHostedRuntime(port);
    let second: Awaited<ReturnType<typeof getNextHostedRuntime>> | null = null;
    try {
      const recoveryId = first.foundation.infrastructure.entries.mint(
        firstWorkspace as AbsolutePath,
        "broken",
        path.join(firstWorkspace, "broken") as AbsolutePath,
      );
      const exchanged = await handleNextHostedRequest(new Request(`http://${host}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { Host: host, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
      }));
      const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0]!;
      const secondNonce = first.nonces.issue();
      const secondExchange = await handleNextHostedRequest(new Request(`http://${host}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { Host: host, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: secondNonce }),
      }));
      expect(secondExchange.status).toBe(204);
      const secondCookie = secondExchange.headers.get("set-cookie")!.split(";", 1)[0]!;
      const secondIdentity = await stat(secondWorkspace, { bigint: true });
      const selectionToken = hostBrowseTokens.mint({
        sessionId: browseSession(cookie),
        canonicalPath: canonicalSecondWorkspace,
        identity: { device: String(secondIdentity.dev), inode: String(secondIdentity.ino) },
      }).token;
      const foreignSession = await handleNextHostedRequest(new Request(`http://${host}/api/v1/workspace/active`, {
        method: "PUT",
        headers: { Host: host, Cookie: secondCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ selectionToken }),
      }));
      expect(foreignSession.status).toBe(400);
      expect(await foreignSession.json()).toMatchObject({ error: { code: ErrorCode.BrowseTokenInvalid } });
      const activated = await handleNextHostedRequest(new Request(`http://${host}/api/v1/workspace/active`, {
        method: "PUT",
        headers: { Host: host, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ selectionToken }),
      }));
      expect(activated.status).toBe(200);
      expect(await activated.json()).toEqual({
        workspaceRoot: canonicalSecondWorkspace,
        reauthRequired: true,
      });
      expect(first.foundation.infrastructure.entries.resolve(recoveryId)).toBeNull();

      second = await getNextHostedRuntime(port);
      expect(second.foundation.infrastructure.workspaceRoot).toBe(canonicalSecondWorkspace);
      const oldSession = await handleNextHostedRequest(new Request(`http://${host}/api/v1/workspace`, {
        headers: { Host: host, Cookie: cookie },
      }));
      expect(oldSession.status).toBe(200);
      expect(await oldSession.json()).toMatchObject({ workspaceRoot: canonicalSecondWorkspace });
    } finally {
      await Promise.allSettled([first.foundation.stop(), second?.foundation.stop()]);
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE;
      else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE;
      else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
      if (prior.settings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = prior.settings;
    }
  });

  it("keeps the old real foundation authoritative when discovery publication fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-workspace-rollback-"));
    roots.push(root);
    const firstPath = path.join(root, "workspace-one");
    const secondPath = path.join(root, "workspace-two");
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
    const [firstWorkspace, secondWorkspace] = await Promise.all([realpath(firstPath), realpath(secondPath)]);
    const appData = path.join(root, "app-data");
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
      settings: process.env.VIDCOM_SETTINGS,
    };
    const nonce = Buffer.alloc(32, 12).toString("base64url");
    const port = 49_334;
    const hostName = `127.0.0.1:${port}`;
    let currentRecord = firstWorkspace;
    let failReplacement = true;
    const host: HostedRuntimeHost = {
      async replaceDiscovery(previous, next) {
        if (previous?.workspaceRoot === currentRecord) currentRecord = "";
        if (failReplacement && next.workspaceRoot === secondWorkspace) {
          failReplacement = false;
          throw new Error("injected discovery publication failure");
        }
        currentRecord = next.workspaceRoot;
      },
      async removeDiscovery(runtime) {
        if (currentRecord === runtime.workspaceRoot) currentRecord = "";
      },
      exitHeadless: () => Promise.reject(new Error("headless exit must not run")),
    };
    process.env.VIDCOM_APP_DATA = appData;
    process.env.VIDCOM_WORKSPACE = firstWorkspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    process.env.VIDCOM_SETTINGS = path.join(root, "setting.json");
    const pending = startNextHostedRuntime(port, firstWorkspace, { host });
    registerHostedRuntime(port, pending);
    const first = await pending;
    let activeBrowseSession = HOST_BROWSE_SESSION;
    try {
      const settings = new AppSettingsStore(first.foundation.infrastructure.database);
      settings.set("active_workspace", firstWorkspace);
      const exchange = await first.app.request(`http://${hostName}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { Host: hostName, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
      const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
      activeBrowseSession = browseSession(cookie);
      const identity = await stat(secondWorkspace, { bigint: true });
      const selectionToken = hostBrowseTokens.mint({
        sessionId: activeBrowseSession,
        canonicalPath: secondWorkspace,
        identity: { device: identity.dev.toString(), inode: identity.ino.toString() },
      }).token;

      const failed = await first.app.request(`http://${hostName}/api/v1/workspace/active`, {
        method: "PUT",
        headers: { Host: hostName, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ selectionToken }),
      });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ error: { code: ErrorCode.WorkspaceUnavailable } });
      expect(currentRecord).toBe(firstWorkspace);
      expect(settings.get("active_workspace")).toBe(firstWorkspace);
      expect((await getNextHostedRuntime(port)).workspaceRoot).toBe(firstWorkspace);

      const created = await first.app.request(`http://${hostName}/api/v1/projects`, {
        method: "POST",
        headers: { Host: hostName, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "After Rollback", presetId: "vertical-shorts" }),
      });
      expect(created.status).toBe(201);
      await expect(access(path.join(firstWorkspace, "after-rollback", "vidcom.json"))).resolves.toBeUndefined();
      await expect(access(path.join(secondWorkspace, "after-rollback"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      hostBrowseTokens.revokeSession(activeBrowseSession);
      await first.foundation.stop();
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE;
      else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE;
      else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
      if (prior.settings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = prior.settings;
    }
  });

  it("imports through the production host wiring and exposes the real async job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-hosted-import-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const source = path.join(root, "outside", "source-project");
    const appData = path.join(root, "app-data");
    await Promise.all([mkdir(workspace), mkdir(source, { recursive: true })]);
    await writeFile(path.join(source, "hyperframes.json"), "{}\n");
    await writeFile(path.join(source, "vidcom.json"), '{"id":"project_hosted_import_source"}\n');
    await writeFile(path.join(source, "index.html"),
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="1"></main>\n');
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
      settings: process.env.VIDCOM_SETTINGS,
    };
    const nonce = Buffer.alloc(32, 11).toString("base64url");
    const port = 49332;
    process.env.VIDCOM_APP_DATA = appData;
    process.env.VIDCOM_WORKSPACE = workspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    process.env.VIDCOM_SETTINGS = path.join(root, "setting.json");
    hostBrowseTokens.revokeSession(HOST_BROWSE_SESSION);
    let runtime: Awaited<ReturnType<typeof startNextHostedRuntime>> | null = null;
    let activeBrowseSession = HOST_BROWSE_SESSION;
    try {
      runtime = await startNextHostedRuntime(port, workspace);
      const host = `127.0.0.1:${port}`;
      const exchange = await runtime.app.request(`http://${host}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { Host: host, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
      expect(exchange.status).toBe(204);
      const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
      activeBrowseSession = browseSession(cookie);
      const identity = await stat(source, { bigint: true });
      const token = hostBrowseTokens.mint({
        sessionId: activeBrowseSession,
        canonicalPath: source,
        identity: { device: identity.dev.toString(), inode: identity.ino.toString() },
      }).token;
      const requestImport = () => runtime!.app.request(`http://${host}/api/v1/projects/imports`, {
        method: "POST",
        headers: { Host: host, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceToken: token, targetName: "Hosted Copy" }),
      });
      const accepted = await requestImport();
      expect(accepted.status).toBe(202);
      const { jobId } = await accepted.json() as { jobId: string };

      let job: { status: string; result?: { slug?: string } } | null = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await runtime.app.request(`http://${host}/api/v1/jobs/${jobId}`, {
          headers: { Host: host, Cookie: cookie },
        });
        expect(response.status).toBe(200);
        job = await response.json() as typeof job;
        if (["succeeded", "partial", "failed", "cancelled"].includes(job!.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(job).toMatchObject({ status: "succeeded", result: { slug: "hosted-copy" } });
      expect(await readFile(path.join(workspace, "hosted-copy", "index.html"), "utf8"))
        .toContain("data-composition-id");
      expect(JSON.parse(await readFile(path.join(workspace, "hosted-copy", "vidcom.json"), "utf8")))
        .toMatchObject({ id: expect.stringMatching(/^project_/u) });
      expect(JSON.parse(await readFile(path.join(source, "vidcom.json"), "utf8")))
        .toEqual({ id: "project_hosted_import_source" });
      expect((await requestImport()).status).toBe(409);
    } finally {
      hostBrowseTokens.revokeSession(activeBrowseSession);
      await runtime?.foundation.stop();
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE;
      else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE;
      else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
      if (prior.settings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = prior.settings;
    }
  }, 15_000);
});
