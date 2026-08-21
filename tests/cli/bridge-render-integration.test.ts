import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonClient, initializeDatabase } from "@vidcom/adapter";
import { ErrorCode, type ProjectId } from "@vidcom/contracts";
import { ok, type AbsolutePath, type JobId, type ProjectIdentity } from "@vidcom/core";
import {
  AttachmentRegistry,
  InMemoryNonceStore,
  InMemorySessionStore,
  bindLoopback,
  createServerApp,
} from "@vidcom/server";
import { enqueueRenderJob, enqueueSnapshotJob } from "@vidcom/worker";
import { describe, expect, it } from "vitest";

import {
  createApplication,
  createInfrastructure,
  hashContent,
} from "../../packages/cli/src/composition-root";
import { createSequentialIdPort } from "../support/deterministic";

const clock = { now: () => new Date("2026-08-09T00:00:00.000Z") };

function qualifiedSceneSource(sceneId: string, duration: number): string {
  return `<!doctype html><html><body><template>
    <style>#${sceneId}{width:1920px;height:1080px}</style>
    <section id="${sceneId}" data-composition-id="${sceneId}" data-scene-role="utility" data-width="1920" data-height="1080" data-duration="${duration}">
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

describe("CLI render bridge against real persistence", () => {
  it("lets only the system bridge bearer enqueue, read and cancel a render", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-bridge-render-")));
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
    const lease = await infrastructure.lease.acquire(workspaceRoot, "test:bridge-render");
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
    const nonces = new InMemoryNonceStore(clock);
    const sessions = new InMemorySessionStore(clock);
    const attachments = new AttachmentRegistry({
      clock,
      instanceId: "daemon_bridge_render",
      autoStarted: true,
      hasActiveWork: () => infrastructure.jobs.hasNonTerminalJob?.() ?? false,
    });
    const listener = await bindLoopback((port) => createServerApp({
      port,
      uiOrigins: [],
      nonces,
      sessions,
      mcpCredentials: {
        verify: (token) => Promise.resolve(
          token === "system-token"
            ? { id: "system-bridge" }
            : token === "user-token" ? { id: "user-credential" } : null,
        ),
      },
      bridge: {
        instanceId: "daemon_bridge_render",
        workspaceRoot,
        daemonVersion: "1.0.0",
        protocolVersions: ["2026-07-28"],
        attachments,
        bridgeCredentialId: () => Promise.resolve("system-bridge"),
        leaseHeld: () => true,
        invokeTool: () => Promise.resolve({ ok: true as const, value: {} }),
      },
      jobs: infrastructure.jobs,
      deliveryLoop: {
        workspaceRoot,
        workspaceOverview: async () => ({
          workspaceRoot,
          source: "explicit",
          entries: await application.scanWorkspace(),
        }),
        activateWorkspace: () => Promise.resolve({
          ok: true as const,
          value: { workspaceRoot, reauthRequired: true as const },
        }),
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
          actor: "user",
        }),
        mimeFromPath: infrastructure.mimeFromPath,
      },
    }));

    try {
      const baseUrl = `http://127.0.0.1:${listener.port}`;
      const exchange = await fetch(`${baseUrl}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: nonces.issue() }),
      });
      expect(exchange.status).toBe(204);
      const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
      if (!cookie) throw new Error("browser session cookie was not issued");
      const browser = (pathname: string, init: RequestInit = {}) => fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
      });

      const created = await browser("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bridge Render", presetId: "horizontal-youtube" }),
      });
      expect(created.status).toBe(201);
      const { projectId } = await created.json() as { projectId: ProjectId };
      const ref = await infrastructure.workspace.readProjectRef(projectId);
      if (!ref) throw new Error("created project was not discoverable");
      const entry = await infrastructure.workspace.readWorkspaceFile!(ref.root, "index.html");
      if (!entry) throw new Error("created project entry was missing");
      const scene = await browser(`/api/v1/projects/${projectId}/scenes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Opening",
          duration: 2,
          expectedContentHash: entry.contentHash,
        }),
      });
      expect(scene.status).toBe(201);
      await writeFile(
        path.join(ref.root, "compositions", "scene-1.html"),
        qualifiedSceneSource("scene-1", 2),
        "utf8",
      );
      expect(await readFile(path.join(ref.root, "vidcom.json"), "utf8")).toContain(projectId);

      const client = createDaemonClient({ baseUrl, bearer: "system-token", deadlineMs: 2_000 });
      const enqueued = await client.enqueueRender(projectId, { idempotencyKey: "bridge-render-1" });
      expect(await client.getJob(enqueued.jobId)).toMatchObject({
        id: enqueued.jobId,
        status: "queued",
      });
      expect(await infrastructure.jobs.get(enqueued.jobId as JobId)).toMatchObject({
        id: enqueued.jobId,
        status: "queued",
        cancelRequested: false,
      });

      const unauthenticatedBridge = await fetch(`${baseUrl}/api/bridge/v1/jobs/${enqueued.jobId}`);
      expect(unauthenticatedBridge.status).toBe(401);
      expect(await unauthenticatedBridge.json()).toMatchObject({
        error: { code: ErrorCode.CredentialInvalid },
      });
      const userCredentialOnBridge = await fetch(
        `${baseUrl}/api/bridge/v1/jobs/${enqueued.jobId}`,
        { headers: { authorization: "Bearer user-token" } },
      );
      expect(await userCredentialOnBridge.json()).toMatchObject({
        error: { code: ErrorCode.BridgeCredentialInvalid },
      });
      const bearerOnBrowserRoute = await fetch(`${baseUrl}/api/v1/jobs/${enqueued.jobId}`, {
        headers: { authorization: "Bearer system-token" },
      });
      expect(bearerOnBrowserRoute.status).toBe(401);
      expect(await bearerOnBrowserRoute.json()).toMatchObject({
        error: { code: ErrorCode.AuthRequired },
      });
      const unauthenticatedBrowserEnqueue = await fetch(
        `${baseUrl}/api/v1/projects/${projectId}/renders`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: "browser-without-session" }),
        },
      );
      expect(unauthenticatedBrowserEnqueue.status).toBe(401);
      expect((await browser(`/api/v1/jobs/${enqueued.jobId}`)).status).toBe(200);

      await client.cancelJob(enqueued.jobId);
      expect(await client.getJob(enqueued.jobId)).toMatchObject({ status: "cancelled" });
      expect(await infrastructure.jobs.get(enqueued.jobId as JobId)).toMatchObject({
        status: "cancelled",
        cancelRequested: true,
      });
    } finally {
      await listener.close();
      await infrastructure.database.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
