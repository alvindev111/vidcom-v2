import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  "settings.file",
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

export const EXPECTED_DOCTOR_ITEM_IDS = Object.freeze([
  "app-data.writable",
  "db.migration",
  "runtime.manifest",
  "runtime.integrity",
  "runtime.ffmpeg",
  "runtime.esbuild-binary",
  "compiler.probe",
  "runtime.hyperframes",
  "runtime.motion",
  "runtime.bgm",
  "runtime.python",
  "runtime.python-utf8",
  "chrome.cache",
  "tts.model-cache",
  "workspace.active",
  "port.available",
  "settings.file",
  "tts.elevenlabs",
]);

export function assertRuntimeHealthy(label, run) {
  const report = parseJson(label, run.stdout);
  if (!Array.isArray(report.items)) throw new Error(`${label} did not report doctor items`);
  const actualIds = report.items.map((item) => item?.id);
  const duplicates = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
  const missing = EXPECTED_DOCTOR_ITEM_IDS.filter((id) => !actualIds.includes(id));
  const unexpected = actualIds.filter((id) => !EXPECTED_DOCTOR_ITEM_IDS.includes(id));
  if (duplicates.length > 0 || missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${label} returned an unexpected doctor schema: ${JSON.stringify({
      duplicates: [...new Set(duplicates)],
      missing,
      unexpected,
    })}`);
  }
  const deferred = new Set([...USER_SUPPLIED_DOCTOR_ITEMS, ...NOT_YET_EXERCISED_DOCTOR_ITEMS]);
  const broken = report.items.filter((item) => item.status !== "ok"
    && !(deferred.has(item.id) && ["missing", "skipped"].includes(item.status)));
  if (broken.length > 0) {
    throw new Error(`${label} found the artifact unhealthy: ${
      broken.map((item) => `${item.id}=${item.status}`).join(", ")}`);
  }
  return report;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function assertExactObjectKeys(label, value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has an unexpected schema: ${JSON.stringify({ expected: wanted, actual })}`);
  }
}

export async function verifyArtifactProvenance(context) {
  const directory = path.dirname(context.artifact);
  const artifactName = path.basename(context.artifact);
  const checksumText = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
  const checksum = /^([0-9a-f]{64})  ([^\r\n]+)\n$/u.exec(checksumText);
  if (!checksum || checksum[2] !== artifactName) {
    throw new Error("SHA256SUMS must contain exactly the packaged artifact");
  }

  const manifest = parseJson(
    "artifact-manifest",
    await readFile(path.join(directory, "artifact-manifest.json"), "utf8"),
  );
  assertExactObjectKeys("artifact-manifest", manifest, [
    "version", "platform", "commit", "dirty", "node", "tools", "runtime", "createdAt", "files",
  ]);
  assertExactObjectKeys("artifact-manifest.tools", manifest.tools, [
    "tar", "postject", "elfSeaInjector", "bun",
  ]);
  assertExactObjectKeys("artifact-manifest.runtime", manifest.runtime, [
    "artifactVersion", "versions", "archives",
  ]);
  assertExactObjectKeys("artifact-manifest.runtime.versions", manifest.runtime.versions, [
    "node", "hyperframes", "esbuild", "ffmpeg", "cpython", "vieneu", "motion",
  ]);
  assertExactObjectKeys("artifact-manifest.runtime.versions.motion", manifest.runtime.versions.motion, [
    "animejs", "gsap", "lottie-web", "motion", "three",
  ]);
  assertExactObjectKeys("artifact-manifest.runtime.archives", manifest.runtime.archives, [
    "bgm", "hyperframes", "node",
  ]);
  for (const [archive, record] of Object.entries(manifest.runtime.archives)) {
    assertExactObjectKeys(`artifact-manifest.runtime.archives.${archive}`, record, ["sha256", "bytes"]);
    if (typeof record.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.sha256)
      || !Number.isSafeInteger(record.bytes) || record.bytes <= 0) {
      throw new Error(`artifact runtime archive provenance is invalid for ${archive}`);
    }
  }
  assertExactObjectKeys("artifact-manifest.files", manifest.files, [artifactName]);
  if (manifest.version !== 1) throw new Error(`unsupported artifact manifest version ${String(manifest.version)}`);
  const expectedPlatform = `${process.platform}-${process.arch}`;
  if (manifest.platform !== expectedPlatform) {
    throw new Error(`artifact platform ${String(manifest.platform)} does not match host ${expectedPlatform}`);
  }
  if (typeof manifest.commit !== "string" || !/^(?:[0-9a-f]{40}|unknown)$/u.test(manifest.commit)) {
    throw new Error("artifact manifest commit is invalid");
  }
  if (typeof manifest.dirty !== "boolean") throw new Error("artifact manifest dirty flag is invalid");
  if (typeof manifest.node !== "string" || !/^v\d+\.\d+\.\d+/u.test(manifest.node)) {
    throw new Error("artifact manifest Node version is invalid");
  }
  if (manifest.runtime.versions.node !== manifest.node.slice(1)) {
    throw new Error("artifact Node version differs from its runtime manifest");
  }
  if (manifest.tools.bun !== "1.3.14") throw new Error("artifact Bun provenance differs from the release pin");
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("artifact manifest createdAt is invalid");
  if (typeof manifest.runtime.artifactVersion !== "string" || manifest.runtime.artifactVersion === "") {
    throw new Error("artifact runtime version is invalid");
  }
  if (!manifest.runtime.versions || typeof manifest.runtime.versions !== "object"
    || !manifest.runtime.archives || typeof manifest.runtime.archives !== "object") {
    throw new Error("artifact runtime provenance is invalid");
  }

  const expectedCommit = context.environment.VIDCOM_SMOKE_EXPECTED_COMMIT;
  if (expectedCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) throw new Error("expected smoke commit is invalid");
    if (manifest.commit !== expectedCommit) {
      throw new Error(`artifact commit ${manifest.commit} does not match workflow commit ${expectedCommit}`);
    }
  }
  if (context.environment.VIDCOM_SMOKE_RELEASE === "1") {
    if (manifest.dirty !== false) throw new Error("a release smoke cannot use an artifact from a modified tree");
    if (expectedCommit === undefined) throw new Error("a release smoke requires VIDCOM_SMOKE_EXPECTED_COMMIT");
  }
  if (context.identity?.runtimeManifest
    && manifest.runtime.artifactVersion !== context.identity.runtimeManifest) {
    throw new Error("artifact runtime version differs from the executable identity");
  }
  if (context.identity?.platform && manifest.platform !== context.identity.platform) {
    throw new Error("artifact platform differs from the executable identity");
  }
  if (context.identity?.buildCommit && manifest.commit !== context.identity.buildCommit) {
    throw new Error("artifact commit differs from the executable identity");
  }

  const actualDigest = await sha256File(context.artifact);
  if (checksum[1] !== actualDigest || manifest.files[artifactName] !== actualDigest) {
    throw new Error(`artifact digest mismatch: ${JSON.stringify({
      checksum: checksum[1],
      manifest: manifest.files[artifactName],
      actual: actualDigest,
    })}`);
  }
  return manifest;
}

export const PRIVATE_PATH_FORBIDDEN_TOOLS = Object.freeze(["node", "python", "python3", "bun"]);

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not print JSON: ${text.trim().slice(0, 200)}`);
  }
}

/** Returns the exact canonical path segments a server-minted browse token must follow. */
export function browsePathSegments(base, target, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(base, target);
  if (relative === "" || relative === ".") return [];
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return null;
  return relative.split(paths.sep).filter(Boolean);
}

/** Windows browse names are case-insensitive even when the API preserves display casing. */
export function browseSegmentMatches(name, segment, platform = process.platform) {
  return platform === "win32" ? name.toLowerCase() === segment.toLowerCase() : name === segment;
}

/** Starts `serve` and waits for the line that says it is answering. */
export async function startServing(context, extraArgs = []) {
  const child = spawn(context.artifact, ["serve", "--workspace", context.workspace, ...extraArgs], {
    cwd: context.cwd,
    env: context.environment,
    // IPC is a parent-held local capability, not a network endpoint. It gives
    // Windows the graceful shutdown that child.kill("SIGTERM") cannot provide.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
  if (serving.child.connected) {
    serving.child.send({ type: "vidcom.shutdown" }, (error) => {
      if (error && serving.child.exitCode === null) serving.child.kill("SIGTERM");
    });
  } else {
    serving.child.kill("SIGTERM");
  }
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

/**
 * Retries one read-only request when a stale keep-alive socket is reset.
 *
 * The render CLI is intentionally driven with spawnSync, which blocks this
 * harness's event loop while a separate daemon renders. The server can retire
 * the harness's idle pooled socket during that wait; the first GET then sees
 * ECONNRESET even though the listener and daemon are still healthy. Only the
 * transport is retried, never an HTTP response and never a mutating request.
 */
export async function readJsonWithTransportRetry(label, url, init, request = fetch) {
  let firstError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await request(url, init);
    } catch (error) {
      if (attempt === 0) {
        firstError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw new Error(
        `${label} transport failed twice: first=${firstError instanceof Error ? firstError.message : String(firstError)}`
        + `; second=${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return jsonResponse(label, response);
  }
  throw new Error(`${label} transport retry did not run`);
}

const SAFE_RENDER_JOB_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

function escapeDiagnosticPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Keeps smoke failure evidence useful without publishing runner paths or credentials. */
export function safeSmokeDiagnosticText(context, value, maxLength = 1_000) {
  let safe = String(value ?? "");
  const secretValues = Object.entries(context.environment ?? {})
    .filter(([name, entry]) => /(?:key|nonce|password|secret|token)/iu.test(name)
      && typeof entry === "string" && entry.length >= 4)
    .map(([, entry]) => entry);
  const pathValues = [
    context.root,
    context.workspace,
    context.cwd,
    context.appData,
    context.artifact,
    context.environment?.HOME,
  ].filter((entry) => typeof entry === "string" && entry.length >= 4);

  for (const entry of [...new Set(secretValues)].sort((left, right) => right.length - left.length)) {
    safe = safe.replace(new RegExp(escapeDiagnosticPattern(entry), "giu"), "<redacted-secret>");
  }
  for (const entry of [...new Set(pathValues)].sort((left, right) => right.length - left.length)) {
    safe = safe.replace(new RegExp(escapeDiagnosticPattern(entry), "giu"), "<redacted-path>");
  }
  safe = safe
    .replace(/\bBearer\s+\S+/giu, "Bearer <redacted-secret>")
    .replace(/\bvcmcp_[A-Za-z0-9._-]+/gu, "<redacted-secret>")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (safe === "") return "<empty>";
  return safe.length <= maxLength ? safe : `…${safe.slice(-(maxLength - 1))}`;
}

/** Read-only post-failure evidence; absence means enqueue never became durable in this phase. */
export async function readLatestRenderJobSince(appData, since) {
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(path.join(appData, "vidcom.sqlite"), { readOnly: true });
    const row = database.prepare(`
      SELECT status, error_code AS errorCode, cleanup_pending AS cleanupPending
      FROM job
      WHERE type = 'render' AND created_at >= ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(since);
    if (!row) return null;
    return {
      status: SAFE_RENDER_JOB_STATUSES.has(row.status) ? row.status : "unknown",
      errorCode: typeof row.errorCode === "string" && /^[A-Za-z0-9._-]{1,80}$/u.test(row.errorCode)
        ? row.errorCode
        : null,
      cleanupPending: row.cleanupPending === 1,
    };
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

function renderJobDiagnostic(job) {
  if (job === undefined) return "unavailable";
  if (job === null) return "none-since-phase";
  return `${job.status}/errorCode=${job.errorCode ?? "null"}/cleanupPending=${String(job.cleanupPending)}`;
}

async function runRenderInvocationWithDiagnostics(
  context,
  serving,
  invocation,
  dependencies = {},
) {
  const now = dependencies.now ?? Date.now;
  const execute = dependencies.runArtifact ?? runArtifact;
  const latestRenderJob = dependencies.readLatestRenderJobSince ?? readLatestRenderJobSince;
  const startedAt = now();
  const since = new Date(startedAt).toISOString();
  let run;
  let failure;
  try {
    run = execute(context, invocation.args, { timeoutMs: invocation.timeoutMs });
    if (run.status === 0) return run;
    failure = `exit ${String(run.status)}; ${run.stderr}`;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  let job;
  try {
    job = await latestRenderJob(context.appData, since);
  } catch {
    job = undefined;
  }
  const elapsedMs = Math.max(0, now() - startedAt);
  const cliExit = run?.status ?? "exception";
  throw new Error(
    `${invocation.label} failed; phase=${invocation.phase} elapsedMs=${String(elapsedMs)}`
    + `; cliExit=${String(cliExit)} cli=${safeSmokeDiagnosticText(context, failure, 500)}`
    + `; daemonExit=${String(serving.child.exitCode)} daemonSignal=${String(serving.child.signalCode)}`
    + `; latestRender=${renderJobDiagnostic(job)}`
    + `; daemonTail=${safeSmokeDiagnosticText(context, serving.output(), 1_000)}`,
  );
}

/** Executes the mutating render exactly once and enriches only its failure path. */
export function runRenderWaitWithDiagnostics(context, serving, media, dependencies = {}) {
  return runRenderInvocationWithDiagnostics(context, serving, {
    label: "render wait",
    phase: "render-wait",
    args: ["render", media.slug, "--workspace", context.workspace],
    timeoutMs: 600_000,
  }, dependencies);
}

/**
 * The CLI permits render preflight/enqueue to run for 300 seconds. Its outer
 * process budget must be longer so SEA startup and Windows AV scanning cannot
 * kill the client before that bounded product deadline reports its own result.
 */
export const DETACHED_RENDER_SMOKE_TIMEOUT_MS = 360_000;

export function runDetachedRenderWithDiagnostics(context, serving, media, dependencies = {}) {
  return runRenderInvocationWithDiagnostics(context, serving, {
    label: "render --detach",
    phase: "render-detach",
    args: ["render", media.slug, "--workspace", context.workspace, "--detach"],
    timeoutMs: DETACHED_RENDER_SMOKE_TIMEOUT_MS,
  }, dependencies);
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

const IMPORT_FIXTURE_ID = "project_0127e186-5e32-45ac-b66f-1c099ff8a292";

/** Writes the same complete project shape that the lifecycle service creates. */
export async function writeImportProjectFixture(root) {
  const occurredAt = "2026-08-13T00:00:00.000Z";
  const platform = {
    presetId: "horizontal-youtube",
    orientation: "horizontal",
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    fps: 30,
    targets: ["youtube"],
    recommendedMaxDurationSeconds: null,
  };
  const identity = {
    schemaVersion: 1,
    id: IMPORT_FIXTURE_ID,
    platform,
    render: { defaultPresetId: platform.presetId, outputDirectory: "renders" },
    narration: { defaultProviderId: null, defaultVoiceId: null },
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "vidcom.json"), `${JSON.stringify(identity, null, 2)}\n`, "utf8"),
    writeFile(path.join(root, "hyperframes.json"), "{}\n", "utf8"),
    writeFile(path.join(root, "preview-settings.json"), "{}\n", "utf8"),
    writeFile(
      path.join(root, "index.html"),
      "<!doctype html>\n<html><head><meta charset=\"UTF-8\"></head><body>\n"
        + "<main data-composition-id=\"main\" data-width=\"1920\" data-height=\"1080\" data-fps=\"30\" data-start=\"0\" data-duration=\"0\" data-no-timeline></main>\n"
        + "</body></html>\n",
      "utf8",
    ),
  ]);
  return identity;
}

/**
 * An authored eight-second story beat with setup, development, payoff and hold.
 * Every selector and start time is literal so the render gate can verify the
 * choreography statically instead of trusting runtime-only animation.
 */
export function mediaSceneSource(gsapEntry) {
  return `<!doctype html>
<html><head><meta charset="UTF-8" /><script src="../${gsapEntry}"></script>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07111f;color:#f8fafc;font-family:Arial,sans-serif}
#scene-1{position:relative;width:1920px;height:1080px;overflow:hidden;background:radial-gradient(circle at 70% 30%,#17345f 0,#07111f 58%)}
#grid{position:absolute;inset:0;background-image:linear-gradient(#38bdf81f 1px,transparent 1px),linear-gradient(90deg,#38bdf81f 1px,transparent 1px);background-size:72px 72px;transform:perspective(700px) rotateX(58deg) scale(1.5);transform-origin:center 80%;opacity:.6}
#hero{position:absolute;left:190px;top:238px;width:1040px;padding:72px 76px;border:2px solid #67e8f9;border-radius:36px;background:linear-gradient(135deg,#0f2848eb,#112846b8);box-shadow:0 40px 120px #020617b3,0 0 55px #22d3ee4d;transform-origin:30% 50%}
#eyebrow{font-size:30px;letter-spacing:.28em;text-transform:uppercase;color:#67e8f9}
#headline{margin:24px 0 0;font-size:112px;line-height:.9;letter-spacing:-.045em}
#headline span{color:#facc15}
#proof{position:absolute;right:170px;top:285px;width:270px;height:270px;border:20px solid #facc15;border-radius:50%;display:grid;place-items:center;background:#07111f;box-shadow:0 0 70px #facc1566;transform-origin:center}
#proof strong{font-size:72px;line-height:1}#proof small{display:block;margin-top:10px;text-align:center;font-size:24px;letter-spacing:.12em;color:#67e8f9}
#hold{position:absolute;left:270px;bottom:115px;font-size:27px;letter-spacing:.2em;text-transform:uppercase;color:#bae6fd}
</style></head><body><template>
<section id="scene-1" data-composition-id="scene-1" data-width="1920" data-height="1080" data-start="0" data-duration="8">
  <div id="grid"></div>
  <article id="hero"><div id="eyebrow">Packaged runtime proof</div><h1 id="headline">Create. Move.<br><span>Deliver.</span></h1></article>
  <aside id="proof"><div><strong>100%</strong><small>OFFLINE</small></div></aside>
  <div id="hold">One binary. Complete motion pipeline.</div>
</section>
<script>
const tl = gsap.timeline({ paused: true });
tl.fromTo("#hero", { scale: 0.42 }, { scale: 1, duration: 1.15, ease: "expo.out" }, 0.15);
tl.fromTo("#hero", { rotation: -9 }, { rotation: 0, duration: 1.05, ease: "power3.out" }, 0.25);
tl.fromTo("#proof", { scale: 0.18 }, { scale: 1, duration: 1.25, ease: "back.out(1.7)" }, 1.55);
tl.fromTo("#proof", { rotation: -175 }, { rotation: 0, duration: 1.2, ease: "expo.out" }, 1.65);
tl.to("#hero", { scale: 1.07, duration: 0.75, ease: "sine.inOut" }, 3.35);
tl.to("#hero", { rotation: 2.2, duration: 0.75, ease: "sine.inOut" }, 3.45);
tl.to("#proof", { scale: 1.16, duration: 0.85, ease: "power3.inOut" }, 4.35);
tl.to("#proof", { rotation: 14, duration: 0.85, ease: "power3.inOut" }, 4.45);
tl.to("#hero", { scale: 1, duration: 0.9, ease: "power2.out" }, 5.45);
tl.to("#hero", { rotation: 0, duration: 0.9, ease: "power2.out" }, 5.55);
tl.to("#proof", { scale: 1, duration: 0.9, ease: "elastic.out(1,0.45)" }, 5.65);
tl.to("#proof", { rotation: 0, duration: 0.9, ease: "elastic.out(1,0.45)" }, 5.75);
window.__timelines = window.__timelines || {};
window.__timelines["scene-1"] = tl;
</script></template></body></html>\n`;
}

async function ensureMediaProject(context, serving) {
  if (context.media) return context.media;
  const projectRoot = path.join(context.workspace, "smoke-media");
  let projectId;
  let sceneContentHash = null;
  try {
    projectId = JSON.parse(await readFile(path.join(projectRoot, "vidcom.json"), "utf8")).id;
  } catch {
    const created = await jsonResponse("create media project", await fetch(`${serving.baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { Cookie: serving.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Smoke Media", presetId: "horizontal-youtube" }),
    }));
    projectId = created.projectId;
  }
  try {
    const existingScene = await readFile(path.join(projectRoot, "compositions", "scene-1.html"), "utf8");
    sceneContentHash = contentHash(existingScene);
  } catch {
    const index = await readFile(path.join(projectRoot, "index.html"), "utf8");
    const scene = await jsonResponse("create media scene", await fetch(
      `${serving.baseUrl}/api/v1/projects/${projectId}/scenes`,
      {
        method: "POST",
        headers: { Cookie: serving.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          title: "VidCom motion proof",
          duration: 8,
          expectedContentHash: contentHash(index),
        }),
      },
    ));
    if (scene.scene?.id !== "scene-1") throw new Error("media project did not create scene-1");
    sceneContentHash = scene.scene.fileContentHash;
  }
  if (typeof projectId !== "string") throw new Error("media project identity has no project id");
  if (typeof sceneContentHash !== "string") throw new Error("media scene has no content hash");

  const installed = await jsonResponse("install GSAP", await fetch(
    `${serving.baseUrl}/api/v1/projects/${projectId}/motion-libraries`,
    {
      method: "POST",
      headers: { Cookie: serving.cookie, "content-type": "application/json" },
      body: JSON.stringify({ libraryId: "gsap" }),
    },
  ));
  if (installed.library?.id !== "gsap" || typeof installed.library.entry !== "string") {
    throw new Error("GSAP install did not return its project-local entry");
  }
  const authored = await jsonResponse("author media motion", await fetch(
    `${serving.baseUrl}/api/v1/projects/${projectId}/files`,
    {
      method: "PUT",
      headers: { Cookie: serving.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        path: "compositions/scene-1.html",
        content: mediaSceneSource(installed.library.entry),
        expectedContentHash: sceneContentHash,
      }),
    },
  ));
  const blocking = authored.diagnostics?.filter((diagnostic) => diagnostic.severity === "error") ?? [];
  if (blocking.length > 0) {
    throw new Error(`media motion authored with blocking diagnostics: ${JSON.stringify(blocking)}`);
  }
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
    context.provenance = await verifyArtifactProvenance(context);
    return `artifact provenance verified at ${path.basename(path.dirname(context.artifact))}`;
  },

  "clean-environment"(context) {
    // Proved by asking the runner, not by trusting the setup: if `node` is still
    // reachable the whole smoke would be measuring the runner's toolchain.
    for (const tool of PRIVATE_PATH_FORBIDDEN_TOOLS) {
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
    context.identity = version;

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
    const cold = runArtifact(
      diagnosticContext,
      ["doctor", "--repair", "--deep", "--json"],
      { timeoutMs: 600_000 },
    );
    const doctorColdMs = Date.now() - doctorColdStartedAt;
    assertRuntimeHealthy("cold doctor --repair --deep", cold);

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
    if (baseline === null) {
      throw new Error(`required committed startup baseline is missing or invalid for ${label}`);
    }
    const evaluation = evaluateStartup(label, startup, baseline);
    const failures = failingResults(evaluation);
    if (failures.length > 0) {
      throw new Error(`startup gate failed: ${failures.map((result) => `${result.name}=${result.value}>${result.limit}`).join(", ")}`);
    }
    context.measurements.doctor = { coldMs: doctorColdMs, warmMs: doctorWarmMs };
    context.measurements.startup = { runner: label, ...startup, baselinePresent: true, evaluation };
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
    const fixtureInput = path.join(context.environment.HOME, "imported-project");
    await writeImportProjectFixture(fixtureInput);
    // Windows TEMP/HOME can use an 8.3 alias such as RUNNER~1 while directory
    // enumeration returns the long name. Follow the canonical identity the
    // server will expose rather than asking it to reproduce a display alias.
    const fixture = await realpath(fixtureInput);

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
        .map((root) => ({
          ...root,
          rootPath: root.canonicalPath ?? root.displayPath,
          segments: browsePathSegments(root.canonicalPath ?? root.displayPath, fixture),
        }))
        .filter((root) => root.segments !== null)
        .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
      if (!base) throw new Error("the browser offered no root containing the fixture");
      let token = base.token;

      for (const segment of base.segments) {
        const page = await browse("entries", { token });
        const next = page.entries.find((entry) => browseSegmentMatches(entry.name, segment) && entry.isDirectory);
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
      let terminal = null;
      while (Date.now() < deadline && status !== "succeeded" && status !== "failed" && status !== "cancelled") {
        const job = await fetch(`${serving.baseUrl}/api/v1/jobs/${jobId}`, { headers });
        if (!job.ok) throw new Error(`job status returned ${String(job.status)}`);
        terminal = await job.json();
        status = terminal.status;
        if (status === "queued" || status === "running") await new Promise((r) => setTimeout(r, 250));
      }
      if (status !== "succeeded") {
        throw new Error(`the import job ended ${status}: ${JSON.stringify(terminal?.error ?? null)}`);
      }

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
      await runRenderWaitWithDiagnostics(context, serving, media);

      const detached = await runDetachedRenderWithDiagnostics(context, serving, media);
      const jobId = detached.stdout.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(jobId)) {
        throw new Error(`render --detach did not print one job id: ${detached.stdout.slice(0, 200)}`);
      }

      const runningDeadline = Date.now() + 120_000;
      let running = null;
      while (Date.now() < runningDeadline) {
        try {
          running = await readJsonWithTransportRetry(
            `detached job ${jobId}`,
            `${serving.baseUrl}/api/v1/jobs/${jobId}`,
            { headers: { Cookie: serving.cookie } },
          );
        } catch (error) {
          // Give an orderly daemon shutdown enough time to publish its failure
          // and exit status before the step's finally block sends our own stop.
          await new Promise((resolve) => setTimeout(resolve, 500));
          throw new Error(
            `detached job ${jobId} poll failed: ${error instanceof Error ? error.message : String(error)}`
            + `${error instanceof Error && error.cause ? ` (${String(error.cause)})` : ""}`
            + `; daemon exit=${String(serving.child.exitCode)} signal=${String(serving.child.signalCode)}`
            + `; daemon tail: ${serving.output().slice(-2_000)}`,
          );
        }
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

    const manifest = await verifyArtifactProvenance(context);
    context.provenance = manifest;
    const beside = await readdir(context.cwd);
    if (beside.length > 0) throw new Error(`the artifact wrote beside itself: ${beside.join(", ")}`);
    return `only ${expected.join(", ")} beside the artifact; commit ${String(manifest.commit).slice(0, 7)}`;
  },
};
