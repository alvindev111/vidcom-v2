import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppDataAssetStager,
  AppDataBackupStore,
  CompositionHf,
  FontkitCompatibilityInspector,
  FsRenderProjectAdapter,
  FsRenderRootAdapter,
  hyperframesRuntimeSource,
  initializeDatabase,
  injectRuntimeAssetGuardDocument,
  LargePreviousContentStore,
  LoopbackRuntimeAssetGuard,
  MutationJournal,
  NodeProcessSupervisor,
  nodeSchedulerTimers,
  SqliteJobStore,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  FontCompatibilityService,
  JobScheduler,
  WriteAuthority,
  type AbsolutePath,
  type BinaryProbePort,
  type JobId,
  type ProcessSupervisorPort,
} from "@vidcom/core";
import {
  createSnapshotJobHandler,
  enqueueSnapshotJob,
  mapSnapshotArtifacts,
} from "@vidcom/worker";

import { createSequentialIdPort } from "../support/deterministic";
import { dbRun } from "../support/database";

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
const roots: string[] = [];
const now = "2026-08-04T00:00:00.000Z";
const clock = { now: () => new Date(now) };
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const hashContent = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-snapshot-job-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const appDataRoot = path.join(root, "app-data");
  const projectRoot = path.join(workspaceRoot, "project");
  await mkdir(path.join(projectRoot, "snapshots"), { recursive: true });
  const projectId = "project_snapshot" as ProjectId;
  const preview = '{"fps":30,"resolution":{"width":1920,"height":1080},"safeZones":[],"background":"#000000","deviceScaleFactor":1}\n';
  await Promise.all([
    writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`),
    writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n"),
    writeFile(path.join(projectRoot, "index.html"), source),
    writeFile(path.join(projectRoot, "preview-settings.json"), preview),
  ]);
  const database = await initializeDatabase(appDataRoot);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
  projectId, workspaceRoot, now, now);
  dbRun(database, `INSERT INTO entity_state
    (project_id, entity, revision, content_hash, backing_path, last_actor, updated_at)
    VALUES (?, 'preview-settings', 0, ?, 'preview-settings.json', 'system', ?)`,
  projectId, hashContent(preview), now);
  const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  const journal = new MutationJournal(database, clock, new LargePreviousContentStore(appDataRoot));
  const jobs = new SqliteJobStore(database, clock);
  const ids = createSequentialIdPort();
  const fonts = new FontCompatibilityService(new FontkitCompatibilityInspector());
  const lease = new WorkspaceLease(database, clock, ids);
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:snapshot");
  if (!acquired.ok) throw new Error("test lease was denied");
  const authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId: acquired.leaseId,
    hashContent,
    invalidate() {},
    notifyEvents() {},
    stagedAssets: new AppDataAssetStager(appDataRoot),
    backups: new AppDataBackupStore(appDataRoot, database, clock, ids),
  });
  const binaries: BinaryProbePort = {
    async probe() {
      return { ok: true as const, value: {
        hyperframesCommand: [process.execPath, "snapshot-fixture.mjs"] as const,
        browserPath: process.execPath as AbsolutePath,
        ffmpegPath: process.execPath as AbsolutePath,
        ffprobePath: process.execPath as AbsolutePath,
        warnings: [],
      } };
    },
  };
  const rootsPort = new FsRenderRootAdapter({
    stagingRoot: path.join(appDataRoot, "render-roots") as AbsolutePath,
    ffmpegPath: process.execPath as AbsolutePath,
    ffprobePath: process.execPath as AbsolutePath,
    clock,
  });
  return {
    root, workspaceRoot, appDataRoot, projectRoot, projectId, source,
    database, workspace, journal, jobs, ids, authority, binaries, rootsPort, fonts,
  };
}

function definition(
  value: Awaited<ReturnType<typeof fixture>>,
  processPort: ProcessSupervisorPort,
) {
  return createSnapshotJobHandler({
    process: processPort,
    roots: value.rootsPort,
    renderProjects: new FsRenderProjectAdapter(),
    authority: value.authority,
    composition: new CompositionHf(),
    workspace: value.workspace,
    journal: value.journal,
    jobs: value.jobs,
    guard: new LoopbackRuntimeAssetGuard(),
    binaries: value.binaries,
    fonts: value.fonts,
    runtimeSource: hyperframesRuntimeSource,
    injectGuard: injectRuntimeAssetGuardDocument,
    clock,
    actor: "system",
  });
}

async function enqueueAndRun(
  value: Awaited<ReturnType<typeof fixture>>,
  processPort: ProcessSupervisorPort,
) {
  const queued = await enqueueSnapshotJob({
    workspace: value.workspace,
    composition: new CompositionHf(),
    journal: value.journal,
    jobs: value.jobs,
    ids: value.ids,
    hashContent,
    binaries: value.binaries,
    fonts: value.fonts,
  }, { projectId: value.projectId });
  if (!queued.ok) throw new Error(queued.error.message);
  const scheduler = new JobScheduler(
    value.jobs,
    clock,
    value.ids,
    [definition(value, processPort)],
    undefined,
    nodeSchedulerTimers,
  );
  await scheduler.runAvailable();
  await scheduler.waitForIdle();
  return value.jobs.get(queued.value.id as JobId);
}

const twoScenes = `<!doctype html><html><head></head><body>
  <main data-composition-id="main" data-width="320" data-height="180" data-duration="2">
    <section data-composition-id="scene-a" data-scene-role="utility" data-start="0" data-duration="1"></section>
    <section data-composition-id="scene-b" data-scene-role="utility" data-start="1" data-duration="1"></section>
  </main>
</body></html>`;

describe("snapshot job with real SQLite and filesystem", () => {
  it("maps files by numeric timestamp and never shifts after a dropped midpoint", async () => {
    const one = new Uint8Array([1]);
    const three = new Uint8Array([3]);
    const mapped = mapSnapshotArtifacts([
      { id: "scene-1", midpoint: 1 },
      { id: "scene-2", midpoint: 2 },
      { id: "scene-3", midpoint: 3 },
    ], [
      { name: "frame-00-at-1s.png", content: one },
      { name: "frame-01-at-3.0s.png", content: three },
      { name: "contact-sheet.png", content: new Uint8Array([9]) },
    ]);
    expect([...mapped.images]).toEqual([["scene-1", one], ["scene-3", three]]);
    expect(mapped.missingSceneIds).toEqual(["scene-2"]);
  });

  it("matches a midpoint with a fourth decimal against the filename HyperFrames writes", async () => {
    // `start + duration / 2` over three-decimal durations lands on four decimals,
    // and HyperFrames rounds the filename to three. Before these agreed, a nine
    // scene project reported six of them missing from a snapshot that had them.
    const captured = new Uint8Array([7]);
    const mapped = mapSnapshotArtifacts(
      [{ id: "scene-1", midpoint: 3.6055 }, { id: "scene-2", midpoint: 48.7775 }],
      [
        { name: "frame-00-at-3.606s.png", content: captured },
        { name: "frame-01-at-48.778s.png", content: captured },
      ],
    );
    expect(mapped.missingSceneIds).toEqual([]);
    expect([...mapped.images.keys()]).toEqual(["scene-1", "scene-2"]);
  });

  it("succeeds empty without spawning and rejects out-of-range midpoint before spawning", async () => {
    let spawns = 0;
    const processPort: ProcessSupervisorPort = {
      async run() { spawns += 1; throw new Error("must not spawn"); },
    };
    const empty = await fixture(`<!doctype html><html><body>
      <main data-composition-id="main" data-duration="1"></main></body></html>`);
    try {
      await expect(enqueueAndRun(empty, processPort)).resolves.toMatchObject({
        status: "succeeded",
        result: { complete: true, sceneCount: 0, sceneIds: [], snapshotPaths: {}, contactSheet: null },
      });
    } finally {
      await empty.database.destroy();
    }
    const invalid = await fixture(`<!doctype html><html><body>
      <main data-composition-id="main" data-duration="1">
        <section data-composition-id="scene-bad" data-scene-role="utility" data-start="1" data-duration="2"></section>
      </main></body></html>`);
    try {
      await expect(enqueueAndRun(invalid, processPort)).resolves.toMatchObject({
        status: "failed",
        error: { code: ErrorCode.TimingInvalid },
      });
      expect(spawns).toBe(0);
    } finally {
      await invalid.database.destroy();
    }
  });

  it("blocks a shallow inline story scene before snapshot enqueue", async () => {
    const value = await fixture(`<!doctype html><html><body>
      <main data-composition-id="main" data-duration="9">
        <section data-composition-id="story" data-start="0" data-duration="9" data-no-timeline>
          <h1 id="title">Static story</h1>
        </section>
      </main></body></html>`);
    try {
      await expect(enqueueSnapshotJob({
        workspace: value.workspace,
        composition: new CompositionHf(),
        journal: value.journal,
        jobs: value.jobs,
        ids: value.ids,
        hashContent,
        binaries: value.binaries,
        fonts: value.fonts,
      }, { projectId: value.projectId })).resolves.toMatchObject({
        ok: false,
        error: {
          code: ErrorCode.ProjectInvalid,
          details: { reason: "story-motion-shallow", sceneIds: ["story"] },
        },
      });
    } finally {
      await value.database.destroy();
    }
  });

  it("retries only missing scenes at the same revision and all scenes after revision changes", async () => {
    const value = await fixture(twoScenes);
    const counter = path.join(value.root, "counter.txt");
    const invocations = path.join(value.root, "invocations.txt");
    const script = path.join(value.root, "snapshot-cli.mjs");
    await writeFile(script, `
      import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      const outputFlag = args.includes("--output") ? "--output" : "-o";
      const output = args[args.indexOf(outputFlag) + 1];
      const values = args[args.indexOf("--at") + 1].split(",");
      let run = Number(await readFile(${JSON.stringify(counter)}, "utf8").catch(() => "0")) + 1;
      await writeFile(${JSON.stringify(counter)}, String(run));
      await appendFile(${JSON.stringify(invocations)}, values.join(",") + "\\n");
      await mkdir(output, { recursive: true });
      const selected = run === 1 || run === 4 ? values.slice(0, 1) : values;
      const png = Buffer.from(${JSON.stringify(pngBase64)}, "base64");
      for (const [index, value] of selected.entries()) {
        await writeFile(output + "/frame-" + String(index).padStart(2, "0") + "-at-" + Number(value) + "s.png", png);
      }
    `);
    const supervisor = new NodeProcessSupervisor();
    const processPort: ProcessSupervisorPort = {
      run: (input) => supervisor.run({
        ...input,
        command: [process.execPath, script, ...input.command.slice(2)],
      }),
    };
    try {
      const first = await enqueueAndRun(value, processPort);
      expect(first).toMatchObject({
        status: "partial",
        result: {
          complete: false,
          computedAtSourceRevision: null,
          partialAtSourceRevision: 0,
          missingSceneIds: ["scene-b"],
          contactSheet: null,
        },
      });
      const second = await enqueueAndRun(value, processPort);
      expect(second).toMatchObject({
        status: "succeeded",
        result: { complete: true, computedAtSourceRevision: 0, missingSceneIds: [] },
      });
      await rm(path.join(value.projectRoot, "snapshots", "scene-0001.png"));
      await expect(enqueueAndRun(value, processPort)).resolves.toMatchObject({
        status: "succeeded",
        result: { complete: true, computedAtSourceRevision: 0, missingSceneIds: [] },
      });
      const changed = `${twoScenes}\n<!-- source revision changed -->\n`;
      await expect(value.authority.mutateSource({
        ref: {
          id: value.projectId,
          slug: "project",
          root: value.projectRoot as AbsolutePath,
          entry: "index.html" as RelPath,
        },
        steps: [{
          kind: "write",
          path: "index.html" as RelPath,
          content: changed,
          expectedContentHash: hashContent(twoScenes),
        }],
        origin: TEST_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "system")).resolves.toMatchObject({ ok: true });
      const third = await enqueueAndRun(value, processPort);
      expect(third).toMatchObject({ status: "partial", result: { missingSceneIds: ["scene-b"] } });
      const changedAgain = `${changed}<!-- source revision changed again -->\n`;
      await expect(value.authority.mutateSource({
        ref: {
          id: value.projectId,
          slug: "project",
          root: value.projectRoot as AbsolutePath,
          entry: "index.html" as RelPath,
        },
        steps: [{
          kind: "write",
          path: "index.html" as RelPath,
          content: changedAgain,
          expectedContentHash: hashContent(changed),
        }],
        origin: TEST_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "system")).resolves.toMatchObject({ ok: true });
      const fourth = await enqueueAndRun(value, processPort);
      expect(fourth).toMatchObject({
        status: "succeeded",
        result: { complete: true, computedAtSourceRevision: 5, missingSceneIds: [] },
      });
      expect((await readFile(invocations, "utf8")).trim().split("\n"))
        .toEqual(["0.5,1.5", "1.5", "0.5,1.5", "0.5,1.5", "0.5,1.5"]);
      expect((await readFile(path.join(value.projectRoot, "snapshots", "contact-sheet.png"))).byteLength)
        .toBeGreaterThan(0);
    } finally {
      await value.database.destroy();
    }
  }, 30_000);
});
