import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateStartup,
  failingResults,
  readBaseline,
  runnerLabel,
} from "../measure-startup.mjs";
import { withRunnerNetworkCut } from "./network-cut.mjs";

/**
 * Runs the packaged executable once and returns everything it said.
 *
 * `shell: false` and an explicit environment, always: the point of every step
 * here is that the artifact works with nothing helpful on PATH, and a shell
 * would quietly put the runner's own back.
 */
export function runArtifact(context, args, options = {}) {
  const result = spawnSync(context.artifact, args, {
    cwd: context.cwd,
    env: context.environment,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs ?? 300_000,
  });
  if (result.error) throw new Error(`${args[0] ?? "artifact"} could not start: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function expectSuccess(label, run) {
  if (run.status !== 0) {
    throw new Error(`${label} exited ${String(run.status)}: ${run.stderr.trim().slice(0, 400)}`);
  }
  return run;
}

/**
 * Items a clean machine is expected to be missing.
 *
 * `doctor` exits non-zero here and it is right to: nobody has chosen a
 * workspace yet, and an ElevenLabs key is a user's to supply. Demanding exit 0
 * made this step assert that a fresh install is misconfigured. What the smoke
 * actually cares about is that every component the *artifact* carries came up.
 */
export const USER_SUPPLIED_DOCTOR_ITEMS = Object.freeze([
  "workspace.active",
  "tts.elevenlabs",
]);

/**
 * Items nothing has exercised yet at step three.
 *
 * Strict turns a skip into a missing, which is right for the job as a whole
 * (R8.4) and wrong here: no browser has been downloaded, no voice model has
 * been used, and no database exists because no workspace has been chosen. The
 * steps that exercise them come later, and that is where they have to be `ok`.
 * Allowing them at the cold check is not a weaker assertion — it is the
 * assertion moving to the point where it can mean something.
 */
export const NOT_YET_EXERCISED_DOCTOR_ITEMS = Object.freeze([
  "db.migration",
  "chrome.cache",
  "tts.model-cache",
]);

function assertRuntimeHealthy(label, run) {
  const report = parseJson(label, run.stdout);
  const allowed = [...USER_SUPPLIED_DOCTOR_ITEMS, ...NOT_YET_EXERCISED_DOCTOR_ITEMS];
  const broken = (report.items ?? []).filter((item) => item.status !== "ok"
    && item.status !== "skipped"
    && !allowed.includes(item.id));
  if (broken.length > 0) {
    throw new Error(`${label} found the artifact unhealthy: ${
      broken.map((item) => `${item.id}=${item.status}`).join(", ")}`);
  }
  return report;
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not print JSON: ${text.trim().slice(0, 200)}`);
  }
}

/** Starts `serve` and waits for the line that says it is answering. */
export async function startServing(context, extraArgs = []) {
  const child = spawn(context.artifact, ["serve", "--workspace", context.workspace, ...extraArgs], {
    cwd: context.cwd,
    env: context.environment,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve exited early (${String(child.exitCode)})\n${output}`);
    const found = /VidCom is serving \S+ at (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
    if (found) return { child, baseUrl: found[1], output: () => output };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill("SIGTERM");
  throw new Error(`serve never announced an address\n${output}`);
}

export async function stopServing(serving) {
  if (serving.child.exitCode !== null) return;
  serving.child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    serving.child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && serving.child.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(serving.child.pid), "/T", "/F"], {
        encoding: "utf8",
        shell: false,
      });
    } else {
      try { process.kill(-serving.child.pid, "SIGKILL"); }
      catch { serving.child.kill("SIGKILL"); }
    }
    await new Promise((resolve) => {
      if (serving.child.exitCode !== null) resolve();
      else serving.child.once("exit", resolve);
    });
  }
}

/**
 * A daemon plus an authenticated browser session.
 *
 * Each step starts its own daemon, so each needs its own session: the session
 * store lives in that process's memory, and a cookie from an earlier step is a
 * cookie for a daemon that has already exited.
 */
export async function startServingWithSession(context) {
  const serving = await startServing(context);
  const nonce = context.environment.VIDCOM_BOOTSTRAP_NONCE;
  const exchange = await fetch(`${serving.baseUrl}/api/v1/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  if (exchange.status !== 204) {
    await stopServing(serving);
    throw new Error(`nonce exchange returned ${String(exchange.status)}`);
  }
  const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) {
    await stopServing(serving);
    throw new Error("nonce exchange omitted the session cookie");
  }
  return { ...serving, cookie };
}

/** A RIFF/WAVE file of the requested size, so the upload is a real audio file. */
export function wavBytes(totalBytes) {
  const bytes = Buffer.alloc(totalBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(totalBytes - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44_100, 24);
  bytes.writeUInt32LE(88_200, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(totalBytes - 44, 40);
  return bytes;
}

const TERMINAL_JOBS = new Set(["succeeded", "partial", "failed", "cancelled"]);

async function jsonResponse(label, response) {
  const text = await response.text();
  let payload;
  try { payload = text.length === 0 ? null : JSON.parse(text); }
  catch { throw new Error(`${label} did not return JSON: ${text.slice(0, 200)}`); }
  if (!response.ok) {
    throw new Error(`${label} returned ${String(response.status)}: ${text.slice(0, 300)}`);
  }
  return payload;
}

async function jobUntilTerminal(serving, jobId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(`${serving.baseUrl}/api/v1/jobs/${jobId}`, {
        headers: { Cookie: serving.cookie },
      });
    } catch (error) {
      throw new Error(
        `job ${jobId} poll failed: ${error instanceof Error ? error.message : String(error)}`
        + `; daemon tail: ${serving.output().slice(-1_000)}`,
      );
    }
    const job = await jsonResponse(`job ${jobId}`, response);
    if (TERMINAL_JOBS.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`job ${jobId} did not become terminal within ${String(timeoutMs)}ms`);
}

function contentHash(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function ensureMediaProject(context, serving) {
  if (context.media) return context.media;
  const projectRoot = path.join(context.workspace, "smoke-media");
  let projectId;
  try {
    projectId = JSON.parse(await readFile(path.join(projectRoot, "vidcom.json"), "utf8")).id;
  } catch {
    const created = await jsonResponse("create media project", await fetch(`${serving.baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { Cookie: serving.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Smoke Media", presetId: "horizontal-youtube" }),
    }));
    projectId = created.projectId;
    const index = await readFile(path.join(projectRoot, "index.html"), "utf8");
    const scene = await jsonResponse("create media scene", await fetch(
      `${serving.baseUrl}/api/v1/projects/${projectId}/scenes`,
      {
        method: "POST",
        headers: { Cookie: serving.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Xin chào từ VidCom",
          duration: 8,
          expectedContentHash: contentHash(index),
        }),
      },
    ));
    if (scene.scene?.id !== "scene-1") throw new Error("media project did not create scene-1");
  }
  if (typeof projectId !== "string") throw new Error("media project identity has no project id");
  context.media = { projectId, slug: "smoke-media", sceneId: "scene-1" };
  return context.media;
}

async function findExecutable(root, filename) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(pathname);
      else if (entry.isFile() && entry.name === filename) return pathname;
    }
  }
  throw new Error(`${filename} was not found under app-data`);
}

async function runMediaPipeline(context, options = {}) {
  const serving = await startServingWithSession(context);
  try {
    const media = await ensureMediaProject(context, serving);
    const voices = await jsonResponse("list TTS voices", await fetch(
      `${serving.baseUrl}/api/v1/projects/${media.projectId}/tts/voices`,
      { headers: { Cookie: serving.cookie } },
    ));
    const provider = voices.providers?.find((candidate) => candidate.id === "vieneu");
    const voice = provider?.voices?.find((candidate) => candidate.recommended)
      ?? provider?.voices?.[0];
    if (!provider?.available || !voice) {
      throw new Error(`VieNeu is unavailable: ${provider?.unavailableReason ?? "provider missing"}`);
    }
    const tts = await jsonResponse("start TTS", await fetch(
      `${serving.baseUrl}/api/v1/projects/${media.projectId}/narration/synthesize`,
      {
        method: "POST",
        headers: {
          Cookie: serving.cookie,
          "content-type": "application/json",
          "Idempotency-Key": `smoke-tts-${randomUUID()}`,
        },
        body: JSON.stringify({
          sceneIds: [media.sceneId],
          providerId: provider.id,
          voiceId: voice.id,
          modelId: voice.modelId,
          computeDevice: "cpu",
        }),
      },
    ));
    const ttsJob = await jobUntilTerminal(serving, tts.jobId);
    if (ttsJob.status !== "succeeded") {
      throw new Error(`TTS job ended ${ttsJob.status}: ${JSON.stringify(ttsJob.error)}`);
    }

    let snapshotJob = null;
    if (options.snapshot !== false) {
      const snapshot = await jsonResponse("start snapshot", await fetch(
        `${serving.baseUrl}/api/v1/projects/${media.projectId}/snapshots`,
        {
          method: "POST",
          headers: { Cookie: serving.cookie, "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: `smoke-snapshot-${randomUUID()}` }),
        },
      ));
      snapshotJob = await jobUntilTerminal(serving, snapshot.jobId);
      if (snapshotJob.status !== "succeeded") {
        throw new Error(`snapshot job ended ${snapshotJob.status}: ${JSON.stringify(snapshotJob.error)}`);
      }
    }

    const render = await jsonResponse("start render", await fetch(
      `${serving.baseUrl}/api/v1/projects/${media.projectId}/renders`,
      {
        method: "POST",
        headers: { Cookie: serving.cookie, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: `smoke-render-${randomUUID()}` }),
      },
    ));
    const renderJob = await jobUntilTerminal(serving, render.jobId);
    if (renderJob.status !== "succeeded") {
      throw new Error(`render job ended ${renderJob.status}: ${JSON.stringify(renderJob.error)}`);
    }
    const downloaded = await fetch(`${serving.baseUrl}/api/v1/renders/${render.jobId}/download`, {
      headers: { Cookie: serving.cookie },
    });
    if (!downloaded.ok) throw new Error(`render download returned ${String(downloaded.status)}`);
    const output = path.join(context.root, `render-${options.label ?? "online"}.mp4`);
    await writeFile(output, Buffer.from(await downloaded.arrayBuffer()));

    const ffprobe = await findExecutable(
      context.appData,
      process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
    );
    const probe = spawnSync(ffprobe, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name:format=duration",
      "-of", "json",
      output,
    ], { env: context.environment, encoding: "utf8", shell: false, timeout: 120_000 });
    if (probe.error || probe.status !== 0) {
      throw new Error(`ffprobe failed: ${probe.error?.message ?? probe.stderr?.slice(0, 300)}`);
    }
    const report = parseJson("ffprobe", probe.stdout);
    const streams = report.streams ?? [];
    if (!streams.some((stream) => stream.codec_type === "video")) throw new Error("render has no video stream");
    if (!streams.some((stream) => stream.codec_type === "audio")) throw new Error("render has no audio stream");
    const duration = Number(report.format?.duration);
    if (!Number.isFinite(duration) || duration < 7 || duration > 10) {
      throw new Error(`render duration ${String(duration)} is outside the expected 8 second window`);
    }
    context.measurements.ffprobe ??= {};
    context.measurements.ffprobe[options.label ?? "online"] = report;
    context.measurements.tts ??= {};
    context.measurements.tts[options.label ?? "online"] = {
      providerId: provider.id,
      voiceId: voice.id,
      platform: `${process.platform}-${process.arch}`,
      assets: ttsJob.result?.assets ?? [],
    };
    return { media, ttsJob, snapshotJob, renderJob, report };
  } finally {
    await stopServing(serving);
  }
}

/**
 * The twelve step bodies of Design §11.4.
 *
 * Each returns a detail string that lands in the evidence document, because a
 * step that only reports "ok" cannot be told apart from a step that did nothing.
 */
export const STEP_BODIES = {
  async build(context) {
    const checksums = path.join(path.dirname(context.artifact), "SHA256SUMS");
    await readFile(checksums, "utf8");
    return `artifact and checksums present at ${path.basename(path.dirname(context.artifact))}`;
  },

  "clean-environment"(context) {
    // Proved by asking the runner, not by trusting the setup: if `node` is still
    // reachable the whole smoke would be measuring the runner's toolchain.
    for (const tool of ["node", "python3", "bun"]) {
      const found = spawnSync(process.platform === "win32" ? "where" : "which", [tool], {
        env: context.environment,
        encoding: "utf8",
        shell: false,
      });
      if (found.status === 0) throw new Error(`${tool} is still on PATH: ${found.stdout.trim()}`);
    }
    const entries = spawnSync(process.platform === "win32" ? "cmd" : "ls", process.platform === "win32"
      ? ["/c", "dir", "/b", context.cwd]
      : [context.cwd], { encoding: "utf8", shell: false });
    if ((entries.stdout ?? "").trim() !== "") {
      throw new Error(`the working directory is not empty: ${entries.stdout.trim()}`);
    }
    return "no node, python or bun on PATH; working directory empty";
  },

  async "restore-caches"(context) {
    const cache = path.join(context.environment.HOME, ".cache");
    const seeded = await readdir(cache).catch(() => []);
    const browser = await readdir(path.join(context.appData, "browser-cache")).catch(() => []);
    const models = await readdir(path.join(context.appData, "models")).catch(() => []);
    const runtime = await readdir(path.join(context.appData, "runtime")).catch(() => []);
    if (runtime.length > 0) throw new Error("restored caches pre-seeded app-data/runtime");
    return `cache restore: HOME ${seeded.length}, browser ${browser.length}, models ${models.length}; app-data/runtime empty`;
  },

  async identify(context) {
    const version = parseJson("version", expectSuccess("version", runArtifact(context, ["version", "--json"])).stdout);
    if (!version.runtimeManifest) throw new Error("a packaged build must know its runtime manifest version");

    // Doctor gets its own app-data root so it can prove both cold and warm
    // diagnostics without warming the serve flow §9.1 actually puts ceilings on.
    const diagnosticContext = {
      ...context,
      environment: {
        ...context.environment,
        VIDCOM_APP_DATA: path.join(context.root, "doctor-app-data"),
      },
    };
    const doctorColdStartedAt = Date.now();
    const cold = runArtifact(diagnosticContext, ["doctor", "--repair", "--json"], { timeoutMs: 600_000 });
    const doctorColdMs = Date.now() - doctorColdStartedAt;
    assertRuntimeHealthy("cold doctor --repair", cold);

    const doctorWarmStartedAt = Date.now();
    const warm = runArtifact(diagnosticContext, ["doctor", "--deep", "--json"]);
    const doctorWarmMs = Date.now() - doctorWarmStartedAt;
    assertRuntimeHealthy("warm doctor --deep", warm);

    const coldServeStartedAt = Date.now();
    const coldServing = await startServing(context);
    const coldServe = Date.now() - coldServeStartedAt;
    await stopServing(coldServing);
    const warmServeStartedAt = Date.now();
    const warmServing = await startServing(context);
    const warmServe = Date.now() - warmServeStartedAt;
    await stopServing(warmServing);

    const label = runnerLabel();
    const startup = { coldServe, warmServe };
    const baseline = await readBaseline(label);
    const evaluation = evaluateStartup(label, startup, baseline);
    const failures = failingResults(evaluation);
    if (failures.length > 0) {
      throw new Error(`startup gate failed: ${failures.map((result) => `${result.name}=${result.value}>${result.limit}`).join(", ")}`);
    }
    context.measurements.doctor = { coldMs: doctorColdMs, warmMs: doctorWarmMs };
    context.measurements.startup = { runner: label, ...startup, baselinePresent: baseline !== null, evaluation };
    return `version ${version.vidcom}/${version.runtimeManifest}; doctor ${String(doctorColdMs)}/${String(doctorWarmMs)}ms; serve ${String(coldServe)}/${String(warmServe)}ms`;
  },

  async "ui-lifecycle"(context) {
    const serving = await startServing(context);
    try {
      const nonce = context.environment.VIDCOM_BOOTSTRAP_NONCE;
      if (!nonce) throw new Error("the smoke environment carries no bootstrap nonce");

      const exchange = await fetch(`${serving.baseUrl}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
      if (exchange.status !== 204) throw new Error(`nonce exchange returned ${String(exchange.status)}`);
      const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
      if (!cookie) throw new Error("nonce exchange omitted the session cookie");

      const created = await fetch(`${serving.baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        // `presetId`, not `preset`: the request schema is strict, so a near-miss
        // field name is a 400 that reads like a server fault.
        body: JSON.stringify({ name: "Smoke", presetId: "vertical-shorts" }),
      });
      if (!created.ok) throw new Error(`creating a project returned ${String(created.status)}`);

      // Health is checked *after* the exchange, not before. The security
      // perimeter requires a session on every path except the exchange itself,
      // and `tests/server/security.test.ts` pins that — so an unauthenticated
      // probe here would be asserting the opposite of a deliberate decision.
      const health = await fetch(`${serving.baseUrl}/api/v1/health`, { headers: { Cookie: cookie } });
      if (!health.ok) throw new Error(`health returned ${String(health.status)}`);
      context.session = { baseUrl: serving.baseUrl, cookie };
      return `served on ${serving.baseUrl}; nonce exchanged and a project created`;
    } finally {
      await stopServing(serving);
    }
  },

  async import(context) {
    // Deliberately outside the workspace: the whole point of import is bringing
    // a directory the daemon does not already own, and a fixture placed inside
    // would pass without exercising that.
    // Under the temporary HOME, which the browser offers as a root. Still
    // outside the workspace — which is what this step is about — but reachable
    // in one descent, so the walk does not depend on where a paged listing of
    // the system temp directory happens to put it.
    const fixture = path.join(context.environment.HOME, "imported-project");
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, "index.html"), "<!doctype html><title>imported</title>\n", "utf8");

    const serving = await startServingWithSession(context);
    try {
      const headers = { Cookie: serving.cookie, "content-type": "application/json" };
      const browse = async (route, body) => {
        const response = await fetch(`${serving.baseUrl}/api/v1/system/filesystem/${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`${route} returned ${String(response.status)}`);
        return response.json();
      };

      // The token is minted by the browse walk and never by the client. That is
      // the point of the design: the server only ever acts on a directory it
      // handed out itself, so a path typed by a caller cannot become an import.
      const { roots } = await browse("roots");
      // The deepest root that contains the fixture, so the walk is as short as
      // the browser allows.
      const base = roots
        .filter((root) => fixture.startsWith(root.displayPath))
        .sort((left, right) => right.displayPath.length - left.displayPath.length)[0];
      if (!base) throw new Error("the browser offered no root containing the fixture");
      let token = base.token;

      const segments = path.relative(base.displayPath, fixture).split(path.sep).filter(Boolean);
      for (const segment of segments) {
        const page = await browse("entries", { token });
        const next = page.entries.find((entry) => entry.name === segment && entry.isDirectory);
        if (!next?.token) throw new Error(`browse could not descend into ${segment}`);
        token = next.token;
      }

      const started = await fetch(`${serving.baseUrl}/api/v1/projects/imports`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceToken: token, targetName: "Imported" }),
      });
      if (started.status === 404) {
        throw new Error(
          "the daemon answers 404 to project imports: the route declares"
          + " `startProjectImport` as an optional dependency and nothing in the"
          + " composition supplies one, so K.6's endpoint is unreachable in every"
          + " mode. `planProjectImport` and the staging copier exist; the job and"
          + " the wiring do not.",
        );
      }
      if (started.status !== 202) {
        throw new Error(`starting the import returned ${String(started.status)}: ${(await started.text()).slice(0, 200)}`);
      }
      const { jobId } = await started.json();
      if (typeof jobId !== "string") throw new Error("the import did not return a job id");

      // Asynchronous by contract, so the smoke waits the way a client does.
      const deadline = Date.now() + 120_000;
      let status = "queued";
      while (Date.now() < deadline && status !== "succeeded" && status !== "failed" && status !== "cancelled") {
        const job = await fetch(`${serving.baseUrl}/api/v1/jobs/${jobId}`, { headers });
        if (!job.ok) throw new Error(`job status returned ${String(job.status)}`);
        status = (await job.json()).status;
        if (status === "queued" || status === "running") await new Promise((r) => setTimeout(r, 250));
      }
      if (status !== "succeeded") throw new Error(`the import job ended ${status}`);

      // The original must be untouched: import copies, it does not move.
      await readFile(path.join(fixture, "index.html"), "utf8");
      return `imported a fixture from outside the workspace as job ${jobId}`;
    } finally {
      await stopServing(serving);
    }
  },

  async bridge(context) {
    // Started first and kept running: the claim under test is "open the app,
    // then run an agent, and both work", so the UI daemon has to be alive for
    // the whole of what follows.
    let serving = await startServingWithSession(context);
    try {
      const issued = runArtifact(context, ["credential", "issue", "smoke-agent"], { timeoutMs: 60_000 });
      if (issued.status !== 0) {
        throw new Error(
          "issuing an agent credential failed inside the artifact"
          + ` (exit ${String(issued.status)}): ${issued.stderr.trim().slice(0, 200)}`
          + " — `credential` calls initializeDatabase directly instead of going through the"
          + " bootstrap coordinator, so it resolves the drizzle folder from import.meta.url,"
          + " which the build rewrites to the /vidcom marker",
        );
      }
      const credential = parseJson("credential issue", issued.stdout);
      if (typeof credential.secret !== "string") throw new Error("credential issue printed no secret");

      const systemBearer = (await readFile(path.join(context.appData, "credentials"), "utf8")).trim();
      const recordFile = path.join(
        context.appData,
        "daemon",
        `${createHash("sha256").update(context.workspace).digest("hex")}.json`,
      );
      const firstRecord = parseJson("first discovery record", await readFile(recordFile, "utf8"));
      const bridgeCall = (pathname, body, bearer = systemBearer) => fetch(`${serving.baseUrl}${pathname}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const handshake = await jsonResponse("bridge handshake", await bridgeCall(
        "/api/bridge/v1/handshake",
        { workspaceRoot: context.workspace, expectedInstanceId: firstRecord.instanceId },
      ));
      if (handshake.instanceId !== firstRecord.instanceId) throw new Error("bridge handshake changed the instance id");

      const created = await jsonResponse("create bridge project", await fetch(`${serving.baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { Cookie: serving.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Bridge State", presetId: "horizontal-youtube" }),
      }));
      const entry = await readFile(path.join(context.workspace, "bridge-state", "index.html"), "utf8");
      await jsonResponse("bridge create_scene", await bridgeCall(
        "/api/bridge/v1/tools/create_scene",
        {
          protocolVersion: "2026-07-28",
          era: "modern",
          input: {
            projectId: created.projectId,
            title: "Written through bridge",
            duration: 2,
            expectedContentHash: contentHash(entry),
          },
        },
      ));

      // The agent reaches the same daemon the UI is using, over the same
      // loopback port, and gets the tool roster from it.
      const listed = await fetch(`${serving.baseUrl}/api/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      if (!listed.ok) throw new Error(`tools/list over the bridge returned ${String(listed.status)}`);
      const text = await listed.text();
      if (!text.includes("list_projects")) {
        throw new Error(`tools/list did not serve the read tools: ${text.slice(0, 200)}`);
      }

      // The UI session still works while the agent holds its own credential —
      // one daemon, two clients, and still one writer.
      const stillServing = await fetch(`${serving.baseUrl}/api/v1/projects`, {
        headers: { Cookie: serving.cookie },
      });
      if (!stillServing.ok) {
        throw new Error(`the UI session stopped working beside the agent: ${String(stillServing.status)}`);
      }

      await stopServing(serving);
      serving = null;
      serving = await startServingWithSession(context);
      const secondRecord = parseJson("second discovery record", await readFile(recordFile, "utf8"));
      if (secondRecord.instanceId === firstRecord.instanceId) {
        throw new Error("a restarted daemon reused its old instance id");
      }
      const stale = await bridgeCall("/api/bridge/v1/handshake", {
        workspaceRoot: context.workspace,
        expectedInstanceId: firstRecord.instanceId,
      });
      if (stale.status < 400 || (await stale.json()).error?.code !== "daemon_identity_mismatch") {
        throw new Error("the restarted daemon accepted a stale handshake");
      }
      const persisted = await jsonResponse("list projects after restart", await bridgeCall(
        "/api/bridge/v1/tools/list_projects",
        { protocolVersion: "2026-07-28", era: "modern", input: {} },
      ));
      if (!persisted.projects?.some((project) => project.slug === "bridge-state")) {
        throw new Error("bridge state did not survive the daemon restart");
      }
      const projectContext = await jsonResponse("read bridge project after restart", await bridgeCall(
        "/api/bridge/v1/tools/get_project_context",
        {
          protocolVersion: "2026-07-28",
          era: "modern",
          input: { projectId: created.projectId },
        },
      ));
      if (projectContext.project?.sceneCount !== 1) {
        throw new Error("the bridge scene did not survive the daemon restart");
      }
      const credentialStillWorks = await fetch(`${serving.baseUrl}/api/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      if (!credentialStillWorks.ok) throw new Error("the agent credential did not survive restart");
      return "bridge read/write ran beside UI; state and credential survived restart; stale handshake rejected";
    } finally {
      if (serving) await stopServing(serving);
    }
  },

  async "render-media"(context) {
    const result = await runMediaPipeline(context, { label: "online", snapshot: true });
    const doctorRun = runArtifact(context, ["doctor", "--deep", "--json"], { timeoutMs: 300_000 });
    const doctor = parseJson("post-media doctor", doctorRun.stdout);
    for (const id of ["db.migration", "runtime.integrity", "chrome.cache", "tts.model-cache"]) {
      const item = doctor.items?.find((candidate) => candidate.id === id);
      if (item?.status !== "ok") throw new Error(`post-media doctor reports ${id}=${item?.status ?? "absent"}`);
    }
    context.measurements.postMediaDoctor = doctor;
    return `VieNeu ${result.ttsJob.result.assets.length} WAV; snapshot succeeded; MP4 ${
      result.report.format.duration}s with video and audio`;
  },

  async "upload-and-progress"(context) {
    const serving = await startServingWithSession(context);
    try {
      const headers = { Cookie: serving.cookie };
      const created = await fetch(`${serving.baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Upload", presetId: "vertical-shorts" }),
      });
      if (!created.ok) throw new Error(`creating a project returned ${String(created.status)}`);
      const project = await created.json();
      const projectId = project.projectId ?? project.id;
      if (typeof projectId !== "string") throw new Error("project create did not return an id");

      const upload = async (bytes) => {
        const form = new FormData();
        form.set("file", new Blob([wavBytes(bytes)], { type: "audio/wav" }), "bgm.wav");
        form.set("expectedRevision", String(project.sourceRevision ?? project.revision ?? 0));
        return fetch(`${serving.baseUrl}/api/v1/projects/${projectId}/assets/bgm`, {
          method: "POST",
          headers,
          body: form,
        });
      };

      // The pair is the point. A 20 MB body has to reach the route and a 21 MB
      // one has to be refused for being too large — one without the other says
      // nothing about where the limit sits.
      const accepted = await upload(20 * 1024 * 1024);
      if (accepted.status === 413) throw new Error("a 20 MB upload was refused as too large");
      const refused = await upload(21 * 1024 * 1024);
      if (refused.status !== 413) {
        throw new Error(`a 21 MB upload returned ${String(refused.status)} rather than 413`);
      }

      // SSE has to arrive unbuffered through the packaged host, which is what
      // the no-buffering header exists to make true across proxies.
      const stream = await fetch(`${serving.baseUrl}/api/v1/events`, {
        headers: { ...headers, "Last-Event-ID": "0" },
      });
      if (!stream.ok) throw new Error(`the event stream returned ${String(stream.status)}`);
      if (stream.headers.get("x-accel-buffering") !== "no") {
        throw new Error("the event stream is missing its no-buffering header");
      }
      await stream.body?.cancel();

      return `20 MB accepted (${String(accepted.status)}), 21 MB refused with 413, event stream unbuffered`;
    } finally {
      await stopServing(serving);
    }
  },

  async "render-cli"(context) {
    const serving = await startServingWithSession(context);
    try {
      const media = await ensureMediaProject(context, serving);
      const wait = runArtifact(context, [
        "render", media.slug, "--workspace", context.workspace,
      ], { timeoutMs: 600_000 });
      if (wait.status !== 0) {
        throw new Error(`render wait exited ${String(wait.status)}: ${wait.stderr.slice(0, 300)}`);
      }

      const detached = runArtifact(context, [
        "render", media.slug, "--workspace", context.workspace, "--detach",
      ], { timeoutMs: 120_000 });
      if (detached.status !== 0) {
        throw new Error(`render --detach exited ${String(detached.status)}: ${detached.stderr.slice(0, 300)}`);
      }
      const jobId = detached.stdout.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(jobId)) {
        throw new Error(`render --detach did not print one job id: ${detached.stdout.slice(0, 200)}`);
      }

      const runningDeadline = Date.now() + 120_000;
      let running = null;
      while (Date.now() < runningDeadline) {
        running = await jsonResponse(`detached job ${jobId}`, await fetch(
          `${serving.baseUrl}/api/v1/jobs/${jobId}`,
          { headers: { Cookie: serving.cookie } },
        ));
        if (running.status === "running" && running.stage === "rendering video") break;
        if (TERMINAL_JOBS.has(running.status)) {
          throw new Error(`detached render became ${running.status} before mid-render cancellation`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (running?.status !== "running" || running.stage !== "rendering video") {
        throw new Error("detached render never reached the rendering-video stage");
      }
      // The stage is persisted immediately before the supervised spawn. Give
      // that spawn one capture interval so this is a real mid-process cancel,
      // not a cancellation between preflight and child creation.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const cancel = await fetch(`${serving.baseUrl}/api/v1/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: { Cookie: serving.cookie },
      });
      if (cancel.status !== 202) throw new Error(`render cancellation returned ${String(cancel.status)}`);
      const terminal = await jobUntilTerminal(serving, jobId);
      if (terminal.status !== "cancelled") {
        throw new Error(`cancelled render ended ${terminal.status}: ${JSON.stringify(terminal.error)}`);
      }
      const proof = await jsonResponse("render termination proof", await fetch(
        `${serving.baseUrl}/api/v1/jobs/${jobId}/termination-proof`,
        { headers: { Cookie: serving.cookie } },
      ));
      if (proof.exhaustive !== true || proof.survivors?.length !== 0) {
        throw new Error(`render termination proof is not exhaustive: ${JSON.stringify(proof)}`);
      }
      if (terminal.cleanupPending === true) throw new Error("cancelled render left cleanup pending");
      const roots = await readdir(path.join(context.appData, "render-roots")).catch(() => []);
      if (roots.includes(jobId)) throw new Error("the marker-backed render workdir survived cancellation");
      context.measurements.renderCancellation = { jobId, proof };
      return `render wait succeeded; detach returned ${jobId}; mid-render cancel recorded exhaustive zero-survivor proof`;
    } finally {
      await stopServing(serving);
    }
  },

  async offline(context) {
    const previousHf = context.environment.HF_HUB_OFFLINE;
    const previousTransformers = context.environment.TRANSFORMERS_OFFLINE;
    context.environment.HF_HUB_OFFLINE = "1";
    context.environment.TRANSFORMERS_OFFLINE = "1";
    try {
      return await withRunnerNetworkCut(async (plan) => {
        const result = await runMediaPipeline(context, { label: "offline", snapshot: false });
        return `${plan}; warm VieNeu and MP4 render succeeded offline (${result.report.format.duration}s)`;
      });
    } finally {
      if (previousHf === undefined) delete context.environment.HF_HUB_OFFLINE;
      else context.environment.HF_HUB_OFFLINE = previousHf;
      if (previousTransformers === undefined) delete context.environment.TRANSFORMERS_OFFLINE;
      else context.environment.TRANSFORMERS_OFFLINE = previousTransformers;
    }
  },

  async "lease-loss"(context) {
    // The record and SQLite row are driven from outside the artifact: this is a
    // process test of the packaged daemon, not a call to the lease-loss helper.
    const { DatabaseSync } = await import("node:sqlite");
    const recordFile = path.join(
      context.appData,
      "daemon",
      `${createHash("sha256").update(context.workspace).digest("hex")}.json`,
    );
    const readRecord = async () => {
      try {
        return JSON.parse(await readFile(recordFile, "utf8"));
      } catch {
        return null;
      }
    };
    const databaseFile = path.join(context.appData, "vidcom.sqlite");
    const takeLease = () => {
      const database = new DatabaseSync(databaseFile);
      try {
        database.prepare("UPDATE workspace_lease SET lease_id = ?, holder_id = ?, expires_at = ?")
          .run(`lease-smoke-${randomUUID()}`, "smoke-other-writer", new Date(Date.now() + 60_000).toISOString());
      } finally {
        database.close();
      }
    };
    const clearLease = () => {
      const database = new DatabaseSync(databaseFile);
      try { database.exec("DELETE FROM workspace_lease"); }
      finally { database.close(); }
    };
    const waitFor = async (predicate, label, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`${label} did not happen before its deadline`);
    };

    const ui = await startServingWithSession(context);
    let uiStopped = false;
    try {
      const record = await readRecord();
      if (!record) throw new Error("a serving daemon published no discovery record");
      if (record.port !== Number(new URL(ui.baseUrl).port)) {
        throw new Error("the published record points at a different port than the listener");
      }
      takeLease();
      await waitFor(async () => await readRecord() === null, "UI discovery withdrawal");
      const bridge = await fetch(`${ui.baseUrl}/api/bridge/v1/tools/list_projects`, {
        method: "POST",
        headers: { Cookie: ui.cookie, "content-type": "application/json" },
        body: "{}",
      });
      // Namespace auth is deliberately evaluated before route matching. Once
      // the foundation has stopped, its credential verifier is gone too, so
      // the inaccessible bridge surface reads as credential_invalid rather
      // than leaking whether a handler is mounted behind a browser cookie.
      if (bridge.status !== 401 || (await bridge.json()).error?.code !== "credential_invalid") {
        throw new Error("UI lease loss left the bridge namespace reachable");
      }
      const workspace = await jsonResponse("no-workspace state", await fetch(
        `${ui.baseUrl}/api/v1/system/workspace`,
        { headers: { Cookie: ui.cookie } },
      ));
      if (workspace.workspaceRoot !== null) throw new Error("UI lease loss did not enter NoWorkspace");
      if (!(await fetch(`${ui.baseUrl}/api/v1/health`, { headers: { Cookie: ui.cookie } })).ok) {
        throw new Error("UI listener died instead of remaining on the bootstrap surface");
      }

      // Remove only the injected winner, then prove a new writer can take over
      // while the old UI daemon remains read-only on the bootstrap surface.
      clearLease();
      const winner = await startServingWithSession(context);
      try {
        const created = await fetch(`${winner.baseUrl}/api/v1/projects`, {
          method: "POST",
          headers: { Cookie: winner.cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Lease Winner", presetId: "vertical-shorts" }),
        });
        if (created.status !== 201) throw new Error(`the takeover writer returned ${String(created.status)}`);
      } finally {
        await stopServing(winner);
      }

      clearLease();
      const headless = await startServing(context);
      let headlessStopped = false;
      try {
        takeLease();
        const exitCode = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("headless daemon did not exit after lease loss")), 30_000);
          headless.child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
        });
        headlessStopped = true;
        if (exitCode === 0 || exitCode === null) {
          throw new Error(`headless lease loss exited ${String(exitCode)} rather than non-zero`);
        }
        if (await readRecord() !== null) throw new Error("headless discovery record survived process exit");
      } finally {
        if (!headlessStopped) await stopServing(headless);
      }
      context.measurements.leaseLoss = { ui: "no-workspace", headless: "non-zero-exit" };
      return "UI kept listener with bridge inaccessible and winner wrote; headless withdrew discovery and exited non-zero";
    } finally {
      if (!uiStopped) {
        await stopServing(ui);
        uiStopped = true;
      }
      clearLease();
    }
  },

  async provenance(context) {
    const directory = path.dirname(context.artifact);
    const entries = (await readdir(directory)).sort();
    const expected = ["SHA256SUMS", "artifact-manifest.json", path.basename(context.artifact)].sort();
    const unexpected = entries.filter((entry) => !expected.includes(entry));
    if (unexpected.length > 0) throw new Error(`unexpected files beside the artifact: ${unexpected.join(", ")}`);

    const manifest = JSON.parse(await readFile(path.join(directory, "artifact-manifest.json"), "utf8"));
    if (manifest.dirty !== false && context.environment.VIDCOM_SMOKE_RELEASE === "1") {
      throw new Error("a release smoke cannot run on an artifact built from a modified tree");
    }
    const beside = await readdir(context.cwd);
    if (beside.length > 0) throw new Error(`the artifact wrote beside itself: ${beside.join(", ")}`);
    return `only ${expected.join(", ")} beside the artifact; commit ${String(manifest.commit).slice(0, 7)}`;
  },
};
