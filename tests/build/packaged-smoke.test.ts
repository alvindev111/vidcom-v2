import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CompositionHf, validateStagedProject } from "@vidcom/adapter";
import type { ProjectId, RelPath } from "@vidcom/contracts";
import { storyMotionDiagnostic, type AbsolutePath } from "@vidcom/core";

import {
  SMOKE_STEPS,
  failedStepIds,
  parseSmokeArgs,
  selectSteps,
  smokeExitCode,
  stepIds,
} from "../../scripts/packaged-smoke/steps.mjs";
import {
  macNetworkCutRoutes,
  networkCutPlan,
} from "../../scripts/packaged-smoke/network-cut.mjs";
import {
  canonicalSmokeDirectories,
  copyCacheContents,
  smokeEnvironment,
} from "../../scripts/packaged-smoke/environment.mjs";
import {
  DETACHED_RENDER_SMOKE_TIMEOUT_MS,
  DETACHED_RENDER_STAGE_TIMEOUT_MS,
  EXPECTED_DOCTOR_ITEM_IDS,
  PRIVATE_PATH_FORBIDDEN_TOOLS,
  assertRuntimeHealthy,
  browsePathSegments,
  browseSegmentMatches,
  cleanupDetachedRenderFailure,
  exercisePackagedMcpStdioPair,
  mediaSceneSource,
  readLatestRenderJobSince,
  readJsonWithTransportRetry,
  runDetachedRenderWithDiagnostics,
  runRenderWaitWithDiagnostics,
  waitForDetachedRenderStage,
  verifyArtifactProvenance,
  writeImportProjectFixture,
} from "../../scripts/packaged-smoke/bodies.mjs";
import { PACKAGED_RUNTIME_SOURCES } from "../../scripts/prepare-packaged-runtime.mjs";
import { completeSmokeEvidence } from "../../scripts/packaged-smoke/evidence.mjs";
import { describe, expect, it } from "vitest";

interface StepResult {
  id: string;
  required: boolean;
  status: "passed" | "failed" | "skipped";
}

function results(entries: Array<Partial<StepResult> & { id: string }>): StepResult[] {
  return entries.map((entry) => ({ required: true, status: "passed", ...entry }));
}

describe("packaged smoke steps", () => {
  it("keeps legacy and modern packaged MCP stdio connected for the coexistence check", async () => {
    const events: string[] = [];
    const closed: string[] = [];
    const session = (era: "legacy" | "modern") => ({
      connect: async () => { events.push(`${era}:connect`); },
      listTools: async () => ({
        tools: [{ name: era === "legacy" ? "list_projects" : "create_scene" }],
      }),
      callTool: async (name: string) => {
        events.push(`${era}:${name}`);
        return name === "list_projects"
          ? { structuredContent: { projects: [{ projectId: "project_smoke" }] } }
          : { structuredContent: { scene: { id: "scene_smoke" } } };
      },
      close: async () => { closed.push(era); },
      stderrBytes: () => 0,
    });

    await expect(exercisePackagedMcpStdioPair({
      artifact: "/private/vidcom",
      workspace: "/private/workspace",
      cwd: "/private/cwd",
      environment: { VIDCOM_TOKEN: "secret-token" },
    }, {
      projectId: "project_smoke",
      createScene: { projectId: "project_smoke" },
    }, {
      createSession: session,
      verifyCoexistence: async () => {
        events.push("coexistence");
        expect(closed).toEqual([]);
      },
    })).resolves.toEqual({ legacyTools: 1, modernTools: 1 });

    expect(events).toEqual([
      "legacy:connect",
      "legacy:list_projects",
      "modern:connect",
      "modern:create_scene",
      "coexistence",
    ]);
    expect(closed).toEqual(["modern", "legacy"]);
  });

  it("redacts packaged MCP stdio failures and closes every connected era", async () => {
    const privateRoot = "C:\\Users\\runner\\private-smoke";
    const secret = "vcmcp_private_token";
    const closed: string[] = [];
    const session = (era: "legacy" | "modern") => ({
      connect: async () => undefined,
      listTools: async () => {
        if (era === "modern") throw new Error(`failed at ${privateRoot} with ${secret}`);
        return { tools: [{ name: "list_projects" }] };
      },
      callTool: async () => ({
        structuredContent: { projects: [{ projectId: "project_smoke" }] },
      }),
      close: async () => { closed.push(era); },
      stderrBytes: () => 0,
    });

    await expect(exercisePackagedMcpStdioPair({
      root: privateRoot,
      artifact: `${privateRoot}\\vidcom.exe`,
      workspace: `${privateRoot}\\workspace`,
      cwd: `${privateRoot}\\cwd`,
      environment: { VIDCOM_TOKEN: secret },
    }, {
      projectId: "project_smoke",
      createScene: { projectId: "project_smoke" },
    }, { createSession: session })).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("modern tools/list");
      expect(message).toContain("<redacted-path>");
      expect(message).toContain("<redacted-secret>");
      expect(message).not.toContain(privateRoot);
      expect(message).not.toContain(secret);
      return true;
    });
    expect(closed.sort()).toEqual(["legacy", "modern"]);
  });

  it("collapses a Windows short alias before deriving daemon discovery identity", async () => {
    const shortRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\vidcom-smoke-fixture";
    const longRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\vidcom-smoke-fixture";
    const requested = {
      root: shortRoot,
      workspace: `${shortRoot}\\workspace`,
      cwd: `${shortRoot}\\cwd`,
      appData: `${shortRoot}\\app-data`,
      home: `${shortRoot}\\home`,
      emptyBin: `${shortRoot}\\empty-bin`,
    };
    const canonical = await canonicalSmokeDirectories(
      requested,
      async (pathname) => pathname.replace(shortRoot, longRoot),
    );
    const environment = smokeEnvironment(canonical.root, { NODE_ENV: "test" }, canonical);

    expect(canonical.workspace).toBe(`${longRoot}\\workspace`);
    expect(environment.VIDCOM_APP_DATA).toBe(`${longRoot}\\app-data`);
    expect(environment.HOME).toBe(`${longRoot}\\home`);
    expect(createHash("sha256").update(canonical.workspace).digest("hex"))
      .toBe(createHash("sha256").update(`${longRoot}\\workspace`).digest("hex"));
  });

  it("walks canonical Windows paths without preserving 8.3 aliases or display casing", () => {
    expect(browsePathSegments(
      "C:\\",
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\imported-project",
      "win32",
    )).toEqual(["Users", "runneradmin", "AppData", "Local", "Temp", "imported-project"]);
    expect(browseSegmentMatches("RunnerAdmin", "runneradmin", "win32")).toBe(true);
    expect(browsePathSegments("D:\\workspace", "C:\\outside", "win32")).toBeNull();
  });

  it("retries one stale transport read without retrying HTTP failures", async () => {
    let attempts = 0;
    const staleThenHealthy = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
      return new Response(JSON.stringify({ status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await expect(readJsonWithTransportRetry(
      "job read",
      "http://127.0.0.1/jobs/job_fixture",
      {},
      staleThenHealthy,
    )).resolves.toEqual({ status: "queued" });
    expect(attempts).toBe(2);

    let rejectedAttempts = 0;
    await expect(readJsonWithTransportRetry(
      "job read",
      "http://127.0.0.1/jobs/job_fixture",
      {},
      async () => {
        rejectedAttempts += 1;
        return new Response(JSON.stringify({ error: "no" }), { status: 503 });
      },
    )).rejects.toThrow(/returned 503/u);
    expect(rejectedAttempts).toBe(1);
  });

  it("turns a render-wait fault into actionable redacted smoke evidence", async () => {
    const secretRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\vidcom-private";
    const secretNonce = "nonce-do-not-publish";
    const secretToken = "vcmcp_do_not_publish";
    const context = {
      root: secretRoot,
      workspace: `${secretRoot}\\workspace`,
      cwd: `${secretRoot}\\cwd`,
      appData: `${secretRoot}\\app-data`,
      artifact: `${secretRoot}\\vidcom.exe`,
      environment: {
        HOME: `${secretRoot}\\home`,
        VIDCOM_BOOTSTRAP_NONCE: secretNonce,
      },
    };
    const serving = {
      child: { exitCode: null, signalCode: null },
      output: () => `render preflight still active at ${secretRoot}; credential=${secretToken}`,
    };
    const times = [1_000, 142_968];

    await expect(runRenderWaitWithDiagnostics(
      context,
      serving,
      { slug: "smoke-media" },
      {
        now: () => times.shift() ?? 142_968,
        runArtifact: () => ({ status: 1, stdout: "", stderr: `internal_error at ${secretRoot}` }),
        readLatestRenderJobSince: async () => ({
          status: "running",
          errorCode: null,
          cleanupPending: false,
        }),
      },
    )).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("phase=render-wait elapsedMs=141968");
      expect(message).toContain("cliExit=1 cli=exit 1; internal_error");
      expect(message).toContain("daemonExit=null daemonSignal=null");
      expect(message).toContain("latestRender=running/errorCode=null/cleanupPending=false");
      expect(message).toContain("daemonTail=render preflight still active");
      expect(message).toContain("<redacted-path>");
      expect(message).toContain("<redacted-secret>");
      expect(message).not.toContain(secretRoot);
      expect(message).not.toContain(secretNonce);
      expect(message).not.toContain(secretToken);
      return true;
    });
  });

  it("reports an exceptional render wait and no durable job without retrying it", async () => {
    let attempts = 0;
    await expect(runRenderWaitWithDiagnostics(
      {
        root: "/private/smoke",
        workspace: "/private/smoke/workspace",
        cwd: "/private/smoke/cwd",
        appData: "/private/smoke/app-data",
        artifact: "/private/smoke/vidcom",
        environment: {},
      },
      { child: { exitCode: 7, signalCode: "SIGABRT" }, output: () => "daemon stopped" },
      { slug: "smoke-media" },
      {
        now: (() => {
          const times = [2_000, 2_125];
          return () => times.shift() ?? 2_125;
        })(),
        runArtifact: () => {
          attempts += 1;
          throw new Error("spawn timed out");
        },
        readLatestRenderJobSince: async () => null,
      },
    )).rejects.toThrow(
      /phase=render-wait elapsedMs=125; cliExit=exception cli=spawn timed out; daemonExit=7 daemonSignal=SIGABRT; latestRender=none-since-phase/u,
    );
    expect(attempts).toBe(1);
  });

  it("lets detached enqueue outlive its 300-second client deadline and diagnoses timeout", async () => {
    let attempts = 0;
    let processTimeout = 0;
    const privateRoot = "C:\\Users\\runneradmin\\private-smoke";
    await expect(runDetachedRenderWithDiagnostics(
      {
        root: privateRoot,
        workspace: `${privateRoot}\\workspace`,
        cwd: `${privateRoot}\\cwd`,
        appData: `${privateRoot}\\app-data`,
        artifact: `${privateRoot}\\vidcom.exe`,
        environment: {},
      },
      { child: { exitCode: null, signalCode: null }, output: () => "enqueue preflight active" },
      { slug: "smoke-media" },
      {
        now: (() => {
          const times = [5_000, 365_000];
          return () => times.shift() ?? 365_000;
        })(),
        runArtifact: (_context: unknown, _args: unknown, options: { timeoutMs: number }) => {
          attempts += 1;
          processTimeout = options.timeoutMs;
          throw new Error(`spawnSync ${privateRoot}\\vidcom.exe ETIMEDOUT`);
        },
        readLatestRenderJobSince: async () => null,
      },
    )).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("render --detach failed; phase=render-detach elapsedMs=360000");
      expect(message).toContain("cliExit=exception");
      expect(message).toContain("latestRender=none-since-phase");
      expect(message).not.toContain(privateRoot);
      return true;
    });
    expect(attempts).toBe(1);
    expect(processTimeout).toBe(DETACHED_RENDER_SMOKE_TIMEOUT_MS);
    expect(DETACHED_RENDER_SMOKE_TIMEOUT_MS).toBe(360_000);
    expect(DETACHED_RENDER_STAGE_TIMEOUT_MS).toBe(360_000);
  });

  it("observes a detached job past 120 seconds but before the bounded stage deadline", async () => {
    let current = 0;
    let reads = 0;
    const result = await waitForDetachedRenderStage(
      { baseUrl: "http://127.0.0.1:1" },
      "job_stage",
      "session=redacted",
      {
        now: () => current,
        sleep: async () => { current += 130_000; },
        readJob: async () => {
          reads += 1;
          return reads < 3
            ? { status: "running", stage: "preparing render" }
            : { status: "running", stage: "rendering video" };
        },
      },
    );
    expect(result).toEqual({
      job: { status: "running", stage: "rendering video" },
      elapsedMs: 260_000,
    });
    expect(reads).toBe(3);
  });

  it("reports bounded elapsed and allowlisted last state when stage observation expires", async () => {
    let current = 0;
    await expect(waitForDetachedRenderStage(
      { baseUrl: "http://127.0.0.1:1" },
      "job_timeout",
      "session=redacted",
      {
        timeoutMs: DETACHED_RENDER_STAGE_TIMEOUT_MS,
        now: () => current,
        sleep: async () => { current += 180_000; },
        readJob: async () => ({ status: "running", stage: "preparing render" }),
      },
    )).rejects.toThrow(
      "elapsedMs=360000; lastStatus=running; lastStage=preparing render",
    );
  });

  it("cancels a timed-out detached job exactly once and records bounded cleanup proof", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const cleanup = await cleanupDetachedRenderFailure(
      { baseUrl: "http://127.0.0.1:1" },
      "job_cleanup",
      "session=redacted",
      {
        fetch: async (url: string, init?: { method?: string }) => {
          requests.push({ url, method: init?.method });
          return init?.method === "POST"
            ? { status: 202 }
            : { ok: true, json: async () => ({ exhaustive: true, survivors: [] }) };
        },
        jobUntilTerminal: async (_serving: unknown, _jobId: string, timeoutMs: number) => {
          expect(timeoutMs).toBe(120_000);
          return { status: "cancelled", cleanupPending: false };
        },
      },
    );
    expect(requests).toEqual([
      { url: "http://127.0.0.1:1/api/v1/jobs/job_cleanup/cancel", method: "POST" },
      { url: "http://127.0.0.1:1/api/v1/jobs/job_cleanup/termination-proof", method: undefined },
    ]);
    expect(cleanup).toBe(
      "terminal-cancelled,cleanupPending-false,proofExhaustive-true,survivors-0",
    );
  });

  it("reads only the latest render job created during the failed phase", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-render-diagnostic-"));
    const databaseFile = path.join(root, "vidcom.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databaseFile);
    try {
      database.exec(`
        CREATE TABLE job (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          error_code TEXT,
          cleanup_pending INTEGER NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      const insert = database.prepare(
        "INSERT INTO job (id, type, status, error_code, cleanup_pending, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("old", "render", "succeeded", null, 0, "2026-08-13T00:00:00.000Z");
      insert.run("new", "render", "failed", "render_timeout", 1, "2026-08-13T00:02:00.000Z");
      insert.run("other", "import", "running", null, 0, "2026-08-13T00:03:00.000Z");
    } finally {
      database.close();
    }

    try {
      await expect(readLatestRenderJobSince(root, "2026-08-13T00:01:00.000Z"))
        .resolves.toEqual({ status: "failed", errorCode: "render_timeout", cleanupPending: true });
      await expect(readLatestRenderJobSince(root, "2026-08-13T00:04:00.000Z"))
        .resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seeds an import source with the complete strict project identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-import-smoke-fixture-"));
    try {
      const identity = await writeImportProjectFixture(root);
      await expect(validateStagedProject(root)).resolves.toBeNull();
      expect(JSON.parse(await readFile(path.join(root, "vidcom.json"), "utf8"))).toEqual(identity);
      expect(identity).toMatchObject({
        schemaVersion: 1,
        platform: {
          presetId: "horizontal-youtube",
          width: 1920,
          height: 1080,
          fps: 30,
        },
        render: { defaultPresetId: "horizontal-youtube", outputDirectory: "renders" },
        narration: { defaultProviderId: null, defaultVoiceId: null },
      });
      await expect(readFile(path.join(root, "preview-settings.json"), "utf8")).resolves.toBe("{}\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("authors statically verifiable multi-phase packaged-smoke motion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-media-smoke-fixture-"));
    try {
      const entry = "assets/vendor/gsap-3.15.0/gsap.min.js";
      await mkdir(path.join(root, "compositions"), { recursive: true });
      await mkdir(path.join(root, path.dirname(entry)), { recursive: true });
      await Promise.all([
        writeFile(path.join(root, "hyperframes.json"), "{}\n", "utf8"),
        writeFile(path.join(root, entry), "/* pinned GSAP fixture */\n", "utf8"),
        writeFile(path.join(root, "compositions", "scene-1.html"), mediaSceneSource(entry), "utf8"),
        writeFile(path.join(root, "index.html"), `<!doctype html><html><body>
          <main data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="8">
            <div id="scene-1-layer" class="comp-layer clip" data-composition-id="scene-1"
              data-composition-src="compositions/scene-1.html" data-start="0" data-duration="8"
              data-track-index="0" data-width="1920" data-height="1080"></div>
          </main></body></html>`, "utf8"),
      ]);
      const model = await new CompositionHf().parseProject({
        id: "project_smoke_motion" as ProjectId,
        slug: "smoke-motion",
        root: root as AbsolutePath,
        entry: "index.html" as RelPath,
      });
      expect(model.scenes).toHaveLength(1);
      expect(model.scenes[0]?.duration).toBe(8);
      expect(model.scenes[0]?.unresolvedEffects).toBe(0);
      expect(
        storyMotionDiagnostic(model.scenes[0]!),
        JSON.stringify(model.scenes[0]?.elements, null, 2),
      ).toBeNull();
      const meaningfulStarts = model.scenes[0]!.elements.flatMap((element) => element.effects)
        .filter((effect) => ["scale", "rotation", "other"].includes(effect.propertyGroup ?? ""))
        .map((effect) => effect.start);
      expect(new Set(meaningfulStarts).size).toBeGreaterThanOrEqual(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the matrix from Design §11.4 in order", () => {
    expect(stepIds()).toEqual([
      "build",
      "clean-environment",
      "restore-caches",
      "identify",
      "ui-lifecycle",
      "import",
      "bridge",
      "render-media",
      "upload-and-progress",
      "render-cli",
      "offline",
      "lease-loss",
      "provenance",
    ]);
  });

  it("treats every step as required", () => {
    // The phase's criterion is that no required step was skipped. A step that
    // was optional would be one nobody notices going quiet.
    expect(SMOKE_STEPS.every((step) => step.required)).toBe(true);
  });

  it("is wired as a script that runs on a developer's machine too", async () => {
    // A smoke that only runs in Actions means every fix to a step costs a push,
    // and after a while nobody fixes them.
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["test:packaged-smoke"]).toBe("node scripts/packaged-smoke/run.mjs");
  });

  it("ships the zip extractor required by a clean machine", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies.yauzl).toBe("3.4.0");
  });

  it("does not turn an empty restored cache into a ready component", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-empty-cache-"));
    try {
      await copyCacheContents(path.join(root, "missing"), path.join(root, "browser-cache"));
      await expect(stat(path.join(root, "browser-cache"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps model-cache symlinks portable across smoke roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-linked-cache-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      await mkdir(path.join(source, "snapshots", "revision"), { recursive: true });
      await mkdir(path.join(source, "blobs"), { recursive: true });
      await writeFile(path.join(source, "blobs", "model"), "weights", "utf8");
      await symlink("../../blobs/model", path.join(source, "snapshots", "revision", "model"));
      await copyCacheContents(source, destination);
      expect(await readlink(path.join(destination, "snapshots", "revision", "model")))
        .toBe(path.normalize("../../blobs/model"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only named cold-machine doctor skips and rejects hidden runtime skips", () => {
    const items = EXPECTED_DOCTOR_ITEM_IDS.map((id) => ({ id, status: "ok" }));
    const workspace = items.find((item) => item.id === "workspace.active");
    if (!workspace) throw new Error("doctor fixture is incomplete");
    workspace.status = "skipped";
    expect(assertRuntimeHealthy("doctor", { stdout: JSON.stringify({ items }) })).toMatchObject({ items });

    const runtime = items.find((item) => item.id === "runtime.python");
    if (!runtime) throw new Error("doctor fixture is incomplete");
    runtime.status = "skipped";
    expect(() => assertRuntimeHealthy("doctor", { stdout: JSON.stringify({ items }) }))
      .toThrow(/runtime\.python=skipped/u);
  });

  it("rehashes artifact provenance and binds release evidence to host and commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-smoke-provenance-"));
    try {
      const directory = path.join(root, "artifact");
      const artifact = path.join(directory, process.platform === "win32" ? "vidcom.exe" : "vidcom");
      await mkdir(directory, { recursive: true });
      const bytes = Buffer.from("artifact-bytes");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const commit = "a".repeat(40);
      const manifest = {
        version: 1,
        platform: `${process.platform}-${process.arch}`,
        commit,
        dirty: false,
        node: process.version,
        tools: { tar: "7.5.22", postject: "1.0.0-alpha.6", elfSeaInjector: "1", bun: "1.3.14" },
        runtime: {
          artifactVersion: "fixture-1",
          versions: {
            node: process.version.slice(1),
            hyperframes: "0.7.86",
            esbuild: "0.25.12",
            ffmpeg: "6.0",
            cpython: "3.12.13+20260805",
            vieneu: "3.2.4",
            motion: { animejs: "4", gsap: "3", "lottie-web": "5", motion: "12", three: "0.18" },
          },
          archives: Object.fromEntries(["bgm", "hyperframes", "node"].map((key) => [
            key,
            { sha256: `sha256:${"c".repeat(64)}`, bytes: 1 },
          ])),
        },
        createdAt: new Date().toISOString(),
        files: { [path.basename(artifact)]: digest },
      };
      await Promise.all([
        writeFile(artifact, bytes),
        writeFile(path.join(directory, "SHA256SUMS"), `${digest}  ${path.basename(artifact)}\n`),
        writeFile(path.join(directory, "artifact-manifest.json"), `${JSON.stringify(manifest)}\n`),
      ]);
      const context = {
        artifact,
        environment: {
          VIDCOM_SMOKE_RELEASE: "1",
          VIDCOM_SMOKE_EXPECTED_COMMIT: commit,
        },
        identity: { runtimeManifest: "fixture-1" },
      };
      await expect(verifyArtifactProvenance(context)).resolves.toMatchObject({ commit });
      await writeFile(artifact, "tampered");
      await expect(verifyArtifactProvenance(context)).rejects.toThrow(/digest mismatch/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps release provenance controls while removing all private-PATH runtimes", () => {
    expect(PRIVATE_PATH_FORBIDDEN_TOOLS).toEqual(["node", "python", "python3", "bun"]);
    const environment = smokeEnvironment("/tmp/vidcom-smoke", {
      PATH: "/usr/bin",
      NODE_ENV: "test",
      VIDCOM_SMOKE_RELEASE: "1",
      VIDCOM_SMOKE_EXPECTED_COMMIT: "b".repeat(40),
    });
    expect(environment).toMatchObject({
      VIDCOM_SMOKE_RELEASE: "1",
      VIDCOM_SMOKE_EXPECTED_COMMIT: "b".repeat(40),
    });
    expect(environment.PATH).toContain("empty-bin");
  });

  it("fails closed when M.6 DoctorReport, raw ffprobe, or platform metadata is absent", () => {
    const tag = `${process.platform}-${process.arch}`;
    const report = {
      streams: [{ codec_type: "video" }, { codec_type: "audio" }],
      format: { duration: "8.0" },
    };
    const context = {
      identity: { platform: tag, runtimeManifest: "fixture-v1", buildCommit: null },
      provenance: {
        platform: tag,
        commit: "a".repeat(40),
        runtime: { artifactVersion: "fixture-v1" },
      },
      measurements: {
        postMediaDoctor: {
          version: 1,
          platform: tag,
          items: EXPECTED_DOCTOR_ITEM_IDS.map((id) => ({ id, status: "ok" })),
        },
        ffprobe: { online: report, offline: report },
      },
    };
    expect(completeSmokeEvidence(tag, context, {
      NODE_ENV: "test",
      VIDCOM_SMOKE_EXPECTED_COMMIT: "a".repeat(40),
    })).toMatchObject({
      doctor: { platform: tag },
      ffprobe: { online: report, offline: report },
      platform: { tag, os: process.platform, architecture: process.arch },
    });
    expect(() => completeSmokeEvidence(tag, {
      ...context,
      measurements: { ...context.measurements, ffprobe: { online: report } },
    })).toThrow(/offline ffprobe evidence/u);
    expect(() => completeSmokeEvidence(tag, {
      ...context,
      measurements: { ...context.measurements, postMediaDoctor: undefined },
    })).toThrow(/DoctorReport evidence/u);
  });
});

describe("native packaged-smoke inputs", () => {
  it("pins one exact Python and non-release media fixture for every smoke platform", () => {
    expect(Object.keys(PACKAGED_RUNTIME_SOURCES).sort()).toEqual([
      "darwin-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    for (const source of Object.values(PACKAGED_RUNTIME_SOURCES)) {
      for (const asset of [source.python, source.ffmpeg, source.ffprobe]) {
        expect(asset.url).toMatch(/^https:\/\/github\.com\//u);
        expect(asset.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
      }
      expect(source.evidence).toMatch(/-package-set(?:-pruned)?\.txt$/u);
    }
  });

  it("requires the workflow to opt in to the unapproved smoke-only media source", async () => {
    const workflow = await readFile(".github/workflows/packaged-smoke.yml", "utf8");
    expect(workflow).toContain('VIDCOM_ALLOW_UNRELEASED_SMOKE_RUNTIME: "1"');
    expect(workflow).toContain("Production FFmpeg acquisition remains behind the human supply-chain gate");
    expect(workflow).toContain("bun-version: 1.3.14");
    expect(workflow).toContain("bun run build:artifact --release");
    expect(workflow).toContain("VIDCOM_SMOKE_EXPECTED_COMMIT:");
    expect(workflow).toContain("VIDCOM_SMOKE_EVIDENCE_DIR:");
    expect(workflow).toContain("doctor-report.json");
    expect(workflow).toContain("ffprobe.json");
    expect(workflow).toContain("platform.json");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("does not duplicate pull-request heavy workflows through the CI wrapper", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow.match(/if: github\.event_name == 'workflow_dispatch'/gu)).toHaveLength(2);
    expect(workflow).not.toContain(
      "github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request'",
    );
  });

  it("keeps real-browser coverage in the browser workflow, not process supervision", async () => {
    const workflow = await readFile(".github/workflows/process-supervision.yml", "utf8");
    const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const contractStep = workflow.match(
      /- name: Production supervisor adapter contract\n\s+run: ([^\n]+)/u,
    );
    expect(contractStep?.[1]).toBeDefined();
    expect(contractStep?.[1]).not.toContain("remote-asset-browser.test.ts");
    expect(workflow).toContain('- "tests/adapter/remote-asset-browser.test.ts"');
    expect(ciWorkflow).toContain(
      "npm run test -- --exclude tests/adapter/remote-asset-browser.test.ts",
    );
    expect(manifest.scripts["test:browser-session"]).toContain(
      "tests/adapter/remote-asset-browser.test.ts",
    );
  });

  it("has an explicit runner-level network cut for each release platform", () => {
    expect(networkCutPlan("darwin")).toContain("reject routes");
    expect(networkCutPlan("linux")).toContain("iptables");
    expect(networkCutPlan("win32")).toContain("firewall rule");
    expect(() => networkCutPlan("freebsd")).toThrow(/no runner network cut/u);
  });

  it("makes macOS external routes reject immediately instead of looping until browser timeout", () => {
    const routes = macNetworkCutRoutes();
    expect(routes).toHaveLength(4);
    for (const route of routes) {
      expect(route.add.at(-1)).toBe("-reject");
      expect(route.delete).not.toContain("-reject");
    }
  });
});

describe("packaged smoke selection", () => {
  it("runs one step, or everything from one step on", () => {
    expect(selectSteps({ step: "bridge" }).map((step) => step.id)).toEqual(["bridge"]);
    expect(selectSteps({ from: "offline" }).map((step) => step.id))
      .toEqual(["offline", "lease-loss", "provenance"]);
    expect(selectSteps({})).toHaveLength(SMOKE_STEPS.length);
  });

  it("refuses a step id that does not exist", () => {
    expect(() => selectSteps({ step: "renders" })).toThrow(/unknown smoke step/u);
    expect(() => parseSmokeArgs(["--step"])).toThrow(/requires a step id/u);
    expect(() => parseSmokeArgs(["--step", "a", "--from", "b"])).toThrow(/cannot be combined/u);
    expect(() => parseSmokeArgs(["--quick"])).toThrow(/unknown smoke argument/u);
  });
});

describe("packaged smoke outcome", () => {
  it("fails on a failed step and names it", () => {
    // Thirteen steps and one "smoke failed" is a report somebody has to
    // reproduce locally before they can even read it.
    const outcome = results([{ id: "bridge", status: "failed" }, { id: "offline" }]);
    expect(smokeExitCode(outcome)).toBe(1);
    expect(failedStepIds(outcome)).toEqual(["bridge"]);
  });

  it("lets a skip pass outside the job, and fail inside it", () => {
    // R8.4 says a missing required component fails the job rather than
    // skipping. Outside the job a skip still means "not reached yet", so the
    // difference is a flag rather than two different meanings of skipped.
    const outcome = results([{ id: "render-media", status: "skipped" }]);
    expect(smokeExitCode(outcome)).toBe(0);
    expect(smokeExitCode(outcome, { strict: true })).toBe(1);
    expect(failedStepIds(outcome, { strict: true })).toEqual(["render-media"]);
  });

  it("takes strict from the environment the job already sets", () => {
    const previous = process.env.VIDCOM_DOCTOR_STRICT;
    process.env.VIDCOM_DOCTOR_STRICT = "1";
    try {
      expect(parseSmokeArgs([]).strict).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.VIDCOM_DOCTOR_STRICT;
      else process.env.VIDCOM_DOCTOR_STRICT = previous;
    }
  });
});
