import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppDataAssetStager,
  AppDataBackupStore,
  CompositionHf,
  FsRenderProjectAdapter,
  FsRenderRootAdapter,
  hyperframesRuntimeSource,
  initializeDatabase,
  injectRuntimeAssetGuardDocument,
  LargePreviousContentStore,
  LoopbackRuntimeAssetGuard,
  MutationJournal,
  NodeProcessSupervisor,
  NodeRenderBinaryProbe,
  nodeSchedulerTimers,
  RENDER_WORKDIR_ORPHAN_GRACE_SECONDS,
  SqliteJobStore,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import { ErrorCode, WarningCode, type ContentHash, type ProjectId } from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  DEFAULT_PREVIEW_SETTINGS,
  JobScheduler,
  WriteAuthority,
  type AbsolutePath,
  type BinaryProbePort,
  type JobId,
  type JobStorePort,
  type ProcessSupervisorPort,
  type RenderRootPort,
} from "@vidcom/core";
import { createRenderJobHandler, enqueueRenderJob } from "@vidcom/worker";

import { createSequentialIdPort } from "../support/deterministic";
import { dbOne, dbRun } from "../support/database";

const roots: string[] = [];
const now = "2026-08-04T00:00:00.000Z";
const clock = { now: () => new Date(now) };
const hashContent = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

async function findExecutable(name: string): Promise<AbsolutePath | null> {
  const candidates = (process.env.PATH ?? "").split(path.delimiter).flatMap((directory) =>
    process.platform === "win32" ? [`${name}.exe`, name].map((file) => path.join(directory, file)) : [path.join(directory, name)]);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate as AbsolutePath;
    } catch {
      // Keep looking through PATH.
    }
  }
  return null;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function baseFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-render-job-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  await mkdir(workspaceRoot);
  const database = await initializeDatabase(appDataRoot);
  const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  const journal = new MutationJournal(database, clock, new LargePreviousContentStore(appDataRoot));
  const jobs = new SqliteJobStore(database, clock);
  const ids = createSequentialIdPort();
  const binaries: BinaryProbePort = {
    async probe() {
      return { ok: true, value: {
        hyperframesCommand: [process.execPath, "render-fixture.mjs"] as const,
        browserPath: process.execPath as AbsolutePath,
        ffmpegPath: process.execPath as AbsolutePath,
        ffprobePath: process.execPath as AbsolutePath,
        warnings: [],
      } };
    },
  };
  return { root, workspaceRoot, appDataRoot, database, workspace, journal, jobs, ids, binaries };
}

async function addProject(
  fixture: Awaited<ReturnType<typeof baseFixture>>,
  slug: string,
  entry: string | null,
) {
  const id = `project_${slug}` as ProjectId;
  const projectRoot = path.join(fixture.workspaceRoot, slug);
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id })}\n`);
  const previewSettings = `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS)}\n`;
  await writeFile(path.join(projectRoot, "preview-settings.json"), previewSettings);
  if (entry !== null) await writeFile(path.join(projectRoot, "index.html"), entry);
  dbRun(fixture.database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  id, fixture.workspaceRoot, slug, now, now);
  dbRun(fixture.database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 0, ?, 'preview-settings.json', 'system', ?)`,
  id, hashContent(previewSettings), now);
  return { id, projectRoot };
}

async function renderHarness(fixture: Awaited<ReturnType<typeof baseFixture>>) {
  const lease = new WorkspaceLease(fixture.database, clock, fixture.ids);
  const acquired = await lease.acquire(fixture.workspaceRoot as AbsolutePath, "test:render-harness");
  if (!acquired.ok) throw new Error("test lease was denied");
  const authority = new WriteAuthority({
    workspace: fixture.workspace,
    journal: fixture.journal,
    compositeJournal: fixture.journal,
    lease,
    leaseId: acquired.leaseId,
    hashContent,
    invalidate() {},
    notifyEvents() {},
    stagedAssets: new AppDataAssetStager(fixture.appDataRoot),
    backups: new AppDataBackupStore(fixture.appDataRoot, fixture.database, clock, fixture.ids),
  });
  const binaryPaths = {
    ffmpegPath: process.execPath as AbsolutePath,
    ffprobePath: process.execPath as AbsolutePath,
  };
  const rootsPort = new FsRenderRootAdapter({
    stagingRoot: path.join(fixture.appDataRoot, "render-roots") as AbsolutePath,
    ...binaryPaths,
    clock,
  });
  const binaries: BinaryProbePort = {
    async probe() {
      return {
        ok: true as const,
        value: {
          hyperframesCommand: [process.execPath, "render-fixture.mjs"] as const,
          browserPath: process.execPath as AbsolutePath,
          ...binaryPaths,
          warnings: [],
        },
      };
    },
  };
  return {
    roots: rootsPort,
    definition(processPort: ProcessSupervisorPort, roots: RenderRootPort = rootsPort) {
      return createRenderJobHandler({
        process: processPort,
        roots,
        renderProjects: new FsRenderProjectAdapter(),
        authority,
        composition: new CompositionHf(),
        workspace: fixture.workspace,
        journal: fixture.journal,
        guard: new LoopbackRuntimeAssetGuard(),
        binaries,
        runtimeSource: hyperframesRuntimeSource,
        injectGuard: injectRuntimeAssetGuardDocument,
        clock,
        actor: "system",
      });
    },
  };
}

async function enqueue(
  fixture: Awaited<ReturnType<typeof baseFixture>>,
  projectId: ProjectId,
  bestEffort?: boolean,
) {
  return enqueueRenderJob({
    workspace: fixture.workspace,
    composition: new CompositionHf(),
    journal: fixture.journal,
    jobs: fixture.jobs,
    ids: fixture.ids,
    hashContent,
    binaries: fixture.binaries,
  }, { projectId, ...(bestEffort === undefined ? {} : { bestEffort }) });
}

async function execute(
  fixture: Awaited<ReturnType<typeof baseFixture>>,
  definition: ReturnType<typeof createRenderJobHandler>,
) {
  const scheduler = new JobScheduler(
    fixture.jobs,
    clock,
    fixture.ids,
    [definition],
    undefined,
    nodeSchedulerTimers,
  );
  await scheduler.runAvailable();
  await scheduler.waitForIdle();
  return scheduler;
}

describe("render job with real SQLite and filesystem", () => {
  it("rejects empty, zero-scene, and invalid projects before enqueue", async () => {
    const fixture = await baseFixture();
    try {
      const empty = await addProject(fixture, "empty", null);
      const zero = await addProject(fixture, "zero", `<!doctype html><html><body>
        <main data-composition-id="main" data-width="320" data-height="180" data-duration="1"></main>
      </body></html>`);
      const invalid = await addProject(fixture, "invalid", "<p>not a composition</p>");
      const dependencies = {
        workspace: fixture.workspace,
        composition: new CompositionHf(),
        journal: fixture.journal,
        jobs: fixture.jobs,
        ids: fixture.ids,
        hashContent,
        binaries: fixture.binaries,
      };

      await expect(enqueueRenderJob(dependencies, { projectId: empty.id }))
        .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.NoComposition } });
      await expect(enqueueRenderJob(dependencies, { projectId: zero.id }))
        .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.NoScenes } });
      await expect(enqueueRenderJob(dependencies, { projectId: invalid.id }))
        .resolves.toMatchObject({
          ok: false,
          error: { code: ErrorCode.ProjectInvalid, details: { reason: ErrorCode.CompositionParseError } },
        });
      expect(dbOne(fixture.database, "SELECT COUNT(*) AS count FROM job")).toEqual({ count: 0 });
    } finally {
      await fixture.database.destroy();
    }
  });

  it("rejects a mounted fade-only story beat and accepts verified multi-phase motion", async () => {
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "story-motion-gate", `<!doctype html><html><body>
        <main data-composition-id="main" data-width="320" data-height="180" data-duration="3">
          <div data-composition-id="scene-1" data-composition-src="compositions/scene-1.html"
            data-start="0" data-duration="3"></div>
        </main></body></html>`);
      await mkdir(path.join(project.projectRoot, "compositions"));
      const source = (motion: string) => `<!doctype html><html><body>
        <section data-composition-id="scene-1" data-duration="3"><div id="hero">Story beat</div>
        <script>const tl = gsap.timeline({ paused: true });${motion}
        window.__timelines = window.__timelines || {}; window.__timelines["scene-1"] = tl;</script>
        </section></body></html>`;
      await writeFile(path.join(project.projectRoot, "compositions/scene-1.html"), source(`
        tl.fromTo("#hero", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0.2);`));

      await expect(enqueue(fixture, project.id)).resolves.toMatchObject({
        ok: false,
        error: { code: ErrorCode.ProjectInvalid, details: { reason: "story-motion-shallow", sceneIds: ["scene-1"] } },
      });
      expect(dbOne(fixture.database, "SELECT COUNT(*) AS count FROM job")).toEqual({ count: 0 });

      await writeFile(path.join(project.projectRoot, "compositions/scene-1.html"), source(`
        tl.fromTo("#hero", { scale: 0.7 }, { scale: 1, duration: 0.6, ease: "expo.out" }, 0.2);
        tl.to("#hero", { rotation: 8, duration: 0.6, ease: "sine.inOut" }, 1.2);`));
      await expect(enqueue(fixture, project.id)).resolves.toMatchObject({ ok: true });
    } finally {
      await fixture.database.destroy();
    }
  });

  it("rejects remote media in a local stylesheet before creating a queue row", async () => {
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "remote-css", `<!doctype html><html><head>
        <link rel="stylesheet" href="styles.css"></head><body>
        <main data-composition-id="main" data-duration="1">
          <section data-composition-id="scene-1" data-start="0" data-duration="1"></section>
        </main></body></html>`);
      await writeFile(path.join(project.projectRoot, "styles.css"), ".hero{background:url(https://assets.test/a.png)}\n");
      await expect(enqueue(fixture, project.id)).resolves.toMatchObject({
        ok: false,
        error: { code: ErrorCode.RemoteAssetNotLocal },
      });
      expect(dbOne(fixture.database, "SELECT COUNT(*) AS count FROM job")).toEqual({ count: 0 });
    } finally {
      await fixture.database.destroy();
    }
  });

  it("probes the shipped toolchain against the selected project root", async () => {
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "version-probe", `<!doctype html><html><body>
        <main data-composition-id="main" data-duration="1">
          <section data-composition-id="scene-1" data-start="0" data-duration="1"></section>
        </main></body></html>`);
      const probedRoots: AbsolutePath[] = [];
      const binaries: BinaryProbePort = {
        async probe(projectRoot) {
          probedRoots.push(projectRoot);
          return fixture.binaries.probe(projectRoot);
        },
      };

      const queued = await enqueueRenderJob({
        workspace: fixture.workspace,
        composition: new CompositionHf(),
        journal: fixture.journal,
        jobs: fixture.jobs,
        ids: fixture.ids,
        hashContent,
        binaries,
      }, { projectId: project.id });

      expect(queued.ok).toBe(true);
      expect(probedRoots).toEqual([project.projectRoot as AbsolutePath]);
    } finally {
      await fixture.database.destroy();
    }
  });

  it("renders through the real process, publishes MP4 and sidecar, and does not advance source revision", async (context) => {
    const [ffmpegPath, ffprobePath] = await Promise.all([findExecutable("ffmpeg"), findExecutable("ffprobe")]);
    if (!ffmpegPath || !ffprobePath) return context.skip("real render requires ffmpeg and ffprobe on PATH");
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "success", `<!doctype html><html><head></head><body>
        <main data-composition-id="main" data-width="320" data-height="180" data-duration="0.2" data-fps="10">
          <section data-composition-id="scene-1" data-start="0" data-duration="0.2"
            style="width:320px;height:180px;background:#123456"></section>
        </main>
      </body></html>`);
      await writeFile(path.join(project.projectRoot, "hyperframes.json"), "{}\n");
      await mkdir(path.join(project.projectRoot, "renders"));
      const lease = new WorkspaceLease(fixture.database, clock, fixture.ids);
      const acquired = await lease.acquire(fixture.workspaceRoot as AbsolutePath, "test:render");
      if (!acquired.ok) throw new Error("test lease was denied");
      const authority = new WriteAuthority({
        workspace: fixture.workspace,
        journal: fixture.journal,
        compositeJournal: fixture.journal,
        lease,
        leaseId: acquired.leaseId,
        hashContent,
        invalidate() {},
        notifyEvents() {},
        stagedAssets: new AppDataAssetStager(fixture.appDataRoot),
        backups: new AppDataBackupStore(fixture.appDataRoot, fixture.database, clock, fixture.ids),
      });
      const binaryPaths = {
        ffmpegPath,
        ffprobePath,
      };
      const definition = createRenderJobHandler({
        process: new NodeProcessSupervisor(),
        roots: new FsRenderRootAdapter({
          stagingRoot: path.join(fixture.appDataRoot, "render-roots") as AbsolutePath,
          ...binaryPaths,
          clock,
        }),
        renderProjects: new FsRenderProjectAdapter(),
        authority,
        composition: new CompositionHf(),
        workspace: fixture.workspace,
        journal: fixture.journal,
        guard: new LoopbackRuntimeAssetGuard(),
        binaries: new NodeRenderBinaryProbe(binaryPaths, { appDataRoot: fixture.appDataRoot }),
        runtimeSource: hyperframesRuntimeSource,
        injectGuard: injectRuntimeAssetGuardDocument,
        clock,
        actor: "system",
      });
      expect(definition).toMatchObject({ type: "render", concurrency: 2, idempotent: false, maxAttempts: 1 });
      const jobId = "job_real_render" as JobId;
      const input = { projectId: project.id, bestEffort: true };
      await fixture.jobs.enqueue({
        id: jobId,
        projectId: project.id,
        type: "render",
        input,
        inputHash: hashContent(canonicalizeJobInput(input)),
        idempotencyKey: null,
      });
      const scheduler = new JobScheduler(
        fixture.jobs,
        clock,
        fixture.ids,
        [definition],
        undefined,
        nodeSchedulerTimers,
      );
      await scheduler.runAvailable();
      await scheduler.waitForIdle();

      const job = await fixture.jobs.get(jobId);
      expect(job?.error).toBeNull();
      expect(job).toMatchObject({ status: "succeeded", result: { computedAtSourceRevision: 0 } });
      expect((await stat(path.join(project.projectRoot, "renders", `${jobId}.mp4`))).size).toBeGreaterThan(0);
      const sidecar = JSON.parse(await readFile(path.join(project.projectRoot, "renders", `${jobId}.json`), "utf8"));
      expect(sidecar).toMatchObject({
        artifactPath: `renders/${jobId}.mp4`,
        reproducible: false,
        externalDependencies: expect.arrayContaining(["https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"]),
      });
      expect(job?.warnings).toContainEqual({
        code: WarningCode.ExternalDependencyUnpinned,
        message: "render used an external script, stylesheet, or font",
      });
      expect(await fixture.journal.latestSourceRevision(project.id)).toBeNull();
      expect(await fixture.journal.latestRevision(project.id)).toBe(1);
    } finally {
      await fixture.database.destroy();
    }
  }, 120_000);

  it("maps strict readiness failure from the pinned token and publishes no artifact", async () => {
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "strict", `<!doctype html><html><body>
        <main data-composition-id="main" data-duration="1">
          <section data-composition-id="scene-1" data-start="0" data-duration="1"></section>
        </main></body></html>`);
      const harness = await renderHarness(fixture);
      const processPort: ProcessSupervisorPort = {
        async run() {
          return {
            status: "exited" as const,
            output: {
              exitCode: 1,
              stdout: "",
              stderr: `code=${WarningCode.SubTimelineReadinessTimeout}`,
              timedOut: false,
            },
          };
        },
      };
      const queued = await enqueue(fixture, project.id, false);
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;
      await execute(fixture, harness.definition(processPort));
      await expect(fixture.jobs.get(queued.value.id as JobId)).resolves.toMatchObject({
        status: "failed",
        error: { code: ErrorCode.SubTimelineReadinessTimeout },
        warnings: [{ code: WarningCode.SubTimelineReadinessTimeout }],
      });
      await expect(access(path.join(project.projectRoot, "renders", `${queued.value.id}.mp4`)))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.database.destroy();
    }
  });

  it("preserves the bounded ffprobe diagnostic when rendered bytes are invalid", async () => {
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "invalid-artifact", `<!doctype html><html><body>
        <main data-composition-id="main" data-duration="1">
          <section data-composition-id="scene-1" data-start="0" data-duration="1"></section>
        </main></body></html>`);
      const harness = await renderHarness(fixture);
      let calls = 0;
      const processPort: ProcessSupervisorPort = {
        async run(input) {
          calls += 1;
          if (calls === 1) {
            const outputIndex = input.command.indexOf("-o");
            const outputPath = input.command[outputIndex + 1];
            if (!outputPath) throw new Error("render command did not name its output");
            await writeFile(outputPath, "not an mp4", "utf8");
          }
          return calls === 1
            ? {
              status: "exited" as const,
              output: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
            }
            : {
              status: "exited" as const,
              output: {
                exitCode: 1,
                stdout: "",
                stderr: "moov atom not found",
                timedOut: false,
              },
            };
        },
      };
      const queued = await enqueue(fixture, project.id);
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;

      await execute(fixture, harness.definition(processPort));

      expect(calls).toBe(2);
      await expect(fixture.jobs.get(queued.value.id as JobId)).resolves.toMatchObject({
        status: "failed",
        error: {
          code: ErrorCode.Internal,
          message: "render artifact validation failed (ffprobe exited 1: moov atom not found)",
        },
      });
    } finally {
      await fixture.database.destroy();
    }
  });

  it("rejects a zero-exit renderer that published no artifact and disables experimental capture", async () => {
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "missing-artifact", `<!doctype html><html><body>
        <main data-composition-id="main" data-duration="1">
          <section data-composition-id="scene-1" data-start="0" data-duration="1"></section>
        </main></body></html>`);
      const harness = await renderHarness(fixture);
      let calls = 0;
      let routerSetting: string | undefined;
      let fastCaptureSetting: string | undefined;
      const processPort: ProcessSupervisorPort = {
        async run(input) {
          calls += 1;
          routerSetting = input.environment?.HF_DE_PARALLEL_ROUTER;
          fastCaptureSetting = input.environment?.PRODUCER_EXPERIMENTAL_FAST_CAPTURE;
          return {
            status: "exited" as const,
            output: {
              exitCode: 0,
              stdout: `${"early warning ".repeat(300)}render completed`,
              stderr: "Render failed: browser navigation was blocked offline",
              timedOut: false,
            },
          };
        },
      };
      const queued = await enqueue(fixture, project.id);
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;

      await execute(fixture, harness.definition(processPort));

      expect(calls).toBe(1);
      expect(routerSetting).toBe("false");
      expect(fastCaptureSetting).toBe("false");
      await expect(fixture.jobs.get(queued.value.id as JobId)).resolves.toMatchObject({
        status: "failed",
        error: {
          code: ErrorCode.Internal,
          message: expect.stringMatching(
            /^HyperFrames exited 0 without producing the render artifact .*Render failed: browser navigation was blocked offline\)$/u,
          ),
        },
      });
    } finally {
      await fixture.database.destroy();
    }
  });

  it("leaves a crashed render marker-owned until every orphan condition allows reclaim", async () => {
    const fixture = await baseFixture();
    try {
      const project = await addProject(fixture, "crash", `<!doctype html><html><body>
        <main data-composition-id="main" data-duration="1">
          <section data-composition-id="scene-1" data-start="0" data-duration="1"></section>
        </main></body></html>`);
      const harness = await renderHarness(fixture);
      const retainedRoots: RenderRootPort = {
        acquire: (id) => harness.roots.acquire(id),
        async release() { return { ok: false, error: "simulated cleanup interruption" }; },
        inspect: (id) => harness.roots.inspect(id),
        reclaimOrphans: (date, running) => harness.roots.reclaimOrphans(date, running),
      };
      const processPort: ProcessSupervisorPort = {
        async run() {
          return {
            status: "exited" as const,
            output: { exitCode: 1, stdout: "", stderr: "renderer_crashed", timedOut: false },
          };
        },
      };
      const queued = await enqueue(fixture, project.id);
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;
      const id = queued.value.id as JobId;
      await execute(fixture, harness.definition(processPort, retainedRoots));
      await expect(fixture.jobs.get(id)).resolves.toMatchObject({ status: "failed", cleanupPending: true });
      await expect(access(path.join(project.projectRoot, "renders", `${id}.mp4`)))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(retainedRoots.inspect(id)).resolves.toBe("owned");
      const oldEnough = new Date(clock.now().getTime() + (RENDER_WORKDIR_ORPHAN_GRACE_SECONDS + 1) * 1_000);
      await expect(retainedRoots.reclaimOrphans(oldEnough, new Set([id])))
        .resolves.toMatchObject({ deleted: 0 });
      await expect(retainedRoots.reclaimOrphans(clock.now(), new Set()))
        .resolves.toMatchObject({ deleted: 0 });
      await expect(retainedRoots.reclaimOrphans(oldEnough, new Set()))
        .resolves.toMatchObject({ deleted: 1, reclaimedJobIds: [id] });
    } finally {
      await fixture.database.destroy();
    }
  });

  it("verifies a real descendant tree is empty before cancelled is persisted", { timeout: 30_000 }, async () => {
    const fixture = await baseFixture();
    let scheduler: JobScheduler | null = null;
    let ownedRoots: Awaited<ReturnType<typeof renderHarness>>["roots"] | null = null;
    let cleanupJobId: JobId | null = null;
    const survivorLedger = path.join(fixture.root, "long-render-survivor.pid");
    try {
      const project = await addProject(fixture, "cancel", `<!doctype html><html><body>
        <main data-composition-id="main" data-duration="1">
          <section data-composition-id="scene-1" data-start="0" data-duration="1"></section>
        </main></body></html>`);
      const script = path.join(fixture.root, "long-render.mjs");
      await writeFile(script, `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true, stdio: "ignore", cwd: process.argv[3]
        });
        writeFileSync(process.argv[2], process.pid + "," + child.pid);
        child.unref();
        setInterval(() => {}, 1000);
      `);
      const harness = await renderHarness(fixture);
      ownedRoots = harness.roots;
      const supervisor = new NodeProcessSupervisor();
      let started!: () => void;
      const processStarted = new Promise<void>((resolve) => { started = resolve; });
      let proof: { survivors: readonly number[] } | null = null;
      const terminalOrder: string[] = [];
      const tracking: ProcessSupervisorPort = {
        async run(input) {
          started();
          const outcome = await supervisor.run({
            ...input,
            command: [process.execPath, script, survivorLedger, tmpdir(), ...input.command.slice(2)],
          });
          if (outcome.status === "terminated") {
            proof = outcome.proof;
            terminalOrder.push("zero-survivor-proof");
          }
          return outcome;
        },
      };
      const queued = await enqueue(fixture, project.id);
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;
      const id = queued.value.id as JobId;
      cleanupJobId = id;
      const orderingStore = new Proxy(fixture.jobs, {
        get(target, property) {
          if (property === "finish") {
            return async (...args: Parameters<SqliteJobStore["finish"]>) => {
              if (args[1].status === "cancelled") terminalOrder.push("cancelled-persist");
              return target.finish(...args);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as JobStorePort;
      scheduler = new JobScheduler(
        orderingStore,
        clock,
        fixture.ids,
        [harness.definition(tracking)],
        undefined,
        nodeSchedulerTimers,
      );
      await scheduler.runAvailable();
      await processStarted;
      await new Promise((resolve) => setTimeout(resolve, 700));
      await fixture.jobs.requestCancel(id);
      await scheduler.waitForIdle();
      expect(proof).toMatchObject({ survivors: [] });
      expect(terminalOrder).toEqual(["zero-survivor-proof", "cancelled-persist"]);
      if (process.platform === "win32" && !(proof as { exhaustive?: boolean } | null)?.exhaustive) {
        expect(["absent", "owned"]).toContain(await harness.roots.inspect(id));
        await expect(fixture.jobs.get(id)).resolves.toMatchObject({ status: "cancelled", cleanupPending: true });
      } else {
        await expect(harness.roots.inspect(id)).resolves.toBe("absent");
        await expect(fixture.jobs.get(id)).resolves.toMatchObject({ status: "cancelled" });
      }
    } finally {
      const fixturePids = (await readFile(survivorLedger, "utf8").catch(() => ""))
        .split(",").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
      for (const fixturePid of fixturePids) {
        try { process.kill(fixturePid, "SIGKILL"); } catch { /* already exited */ }
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try { process.kill(fixturePid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); }
          catch { break; }
        }
      }
      if (ownedRoots && cleanupJobId) {
        await ownedRoots.release(cleanupJobId);
      }
      await scheduler?.stop();
      await fixture.database.destroy();
    }
  });
});
