import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializeDatabase } from "@vidcom/adapter";
import { getNextHostedRuntime, handleNextHostedRequest } from "@vidcom/cli";
import { ErrorCode, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  type AbsolutePath,
  type DerivedMutationPath,
  type JobId,
  type ProjectIdentity,
} from "@vidcom/core";
import { createServerApp, errorStatus, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";
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
  };
  const port = 43219;
  const nonces = new InMemoryNonceStore(clock);
  const sessions = new InMemorySessionStore(clock);
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
      activateWorkspace: async () => ({ ok: true, value: { workspaceRoot, reauthRequired: true } }),
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
  return { root, workspaceRoot, infrastructure, application, request };
}

describe("project delivery HTTP routes on real SQLite and filesystem", () => {
  it("maps the Phase-O error categories to their approved HTTP statuses", () => {
    expect([
      ErrorCode.SchemaInvalid,
      ErrorCode.PreconditionRequired,
      ErrorCode.ProjectInvalid,
      ErrorCode.NoComposition,
      ErrorCode.NoScenes,
      ErrorCode.RemoteAssetNotLocal,
      ErrorCode.AssetNotAllowed,
      ErrorCode.PathOutsideProject,
      ErrorCode.RenderBinaryMissing,
      ErrorCode.ProcessTerminationUnverified,
      ErrorCode.ApprovalRequired,
      ErrorCode.ConfirmationRequired,
      ErrorCode.StorageUnavailable,
      ErrorCode.Internal,
    ].map(errorStatus)).toEqual([400, 409, 409, 422, 422, 422, 403, 403, 503, 500, 403, 403, 500, 500]);
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
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: value.workspaceRoot }),
      })).status).toBe(200);
    } finally {
      await value.infrastructure.database.destroy();
    }
  });

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
      expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([2, 3, 4]);
      const etag = ranged.headers.get("etag")!;
      expect((await value.request("/api/v1/renders/job_download/download", {
        headers: { "If-None-Match": etag },
      })).status).toBe(304);

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

  it("hot-swaps the selected workspace, clears recovery tokens, and requires reauthentication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-workspace-swap-"));
    roots.push(root);
    const firstWorkspace = path.join(root, "workspace-one");
    const secondWorkspace = path.join(root, "workspace-two");
    const appData = path.join(root, "app-data");
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
    };
    const nonce = Buffer.alloc(32, 9).toString("base64url");
    const port = 49331;
    const host = `127.0.0.1:${port}`;
    process.env.VIDCOM_APP_DATA = appData;
    process.env.VIDCOM_WORKSPACE = firstWorkspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
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
      const activated = await handleNextHostedRequest(new Request(`http://${host}/api/v1/workspace/active`, {
        method: "PUT",
        headers: { Host: host, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ path: secondWorkspace }),
      }));
      expect(activated.status).toBe(200);
      expect(await activated.json()).toEqual({
        workspaceRoot: secondWorkspace,
        reauthRequired: true,
      });
      expect(first.foundation.infrastructure.entries.resolve(recoveryId)).toBeNull();

      second = await getNextHostedRuntime(port);
      expect(second.foundation.infrastructure.workspaceRoot).toBe(secondWorkspace);
      const oldSession = await handleNextHostedRequest(new Request(`http://${host}/api/v1/workspace`, {
        headers: { Host: host, Cookie: cookie },
      }));
      expect(oldSession.status).toBe(401);
    } finally {
      await Promise.allSettled([first.foundation.stop(), second?.foundation.stop()]);
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE;
      else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE;
      else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
    }
  });
});
