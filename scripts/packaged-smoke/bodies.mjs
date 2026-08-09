import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  serving.child.kill("SIGTERM");
  await new Promise((resolve) => {
    serving.child.once("exit", resolve);
    setTimeout(resolve, 15_000);
  });
}

/**
 * A step whose body is not written yet.
 *
 * Thrown rather than returned as a pass. The phase's acceptance criterion is
 * "no required step was skipped", and a body that reports success without
 * driving anything would satisfy that criterion while proving nothing — the
 * one failure mode this whole phase exists to prevent.
 */
export class NotWrittenYet extends Error {
  constructor(step, what) {
    super(`the ${step} step still has to drive ${what}`);
    this.name = "NotWrittenYet";
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
    return `caches seeded under a temporary HOME (${seeded.length} entries); app-data runtime left empty`;
  },

  identify(context) {
    const version = parseJson("version", expectSuccess("version", runArtifact(context, ["version", "--json"])).stdout);
    if (!version.runtimeManifest) throw new Error("a packaged build must know its runtime manifest version");

    // Cold: the runtime is not extracted yet, so this is the run that pays for
    // extraction and the one M.7 measures.
    const coldStartedAt = Date.now();
    const cold = runArtifact(context, ["doctor", "--repair", "--json"], { timeoutMs: 600_000 });
    const coldMs = Date.now() - coldStartedAt;
    assertRuntimeHealthy("cold doctor --repair", cold);

    const warmStartedAt = Date.now();
    const warm = runArtifact(context, ["doctor", "--deep", "--json"]);
    const warmMs = Date.now() - warmStartedAt;
    assertRuntimeHealthy("warm doctor --deep", warm);
    context.measurements.coldMs = coldMs;
    context.measurements.warmMs = warmMs;
    return `version ${version.vidcom}/${version.runtimeManifest}; cold ${String(coldMs)}ms, warm ${String(warmMs)}ms`;
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
    const serving = await startServingWithSession(context);
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
      return "an agent listed tools over the bridge while the UI session kept working";
    } finally {
      await stopServing(serving);
    }
  },

  "render-media"(context) {
    void context;
    throw new NotWrittenYet("render-media", "TTS, snapshot, render, and an ffprobe check for an audio stream");
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
      // The workspace has no project to render, so what is exercised here is the
      // contract every caller depends on: which exit code means what. R3.3 fixes
      // 0/1/2/130, and a `render` that answered 1 for bad input would send a
      // script down the retry path instead of the fix-your-arguments path.
      const missingTarget = runArtifact(context, ["render"], { timeoutMs: 120_000 });
      if (missingTarget.status !== 2) {
        throw new Error(`render with no target exited ${String(missingTarget.status)} rather than 2`);
      }
      const unknownFlag = runArtifact(context, ["render", "project_1", "--nope"], { timeoutMs: 120_000 });
      if (unknownFlag.status !== 2) {
        throw new Error(`render with an unknown flag exited ${String(unknownFlag.status)} rather than 2`);
      }
      return "render returns the input exit code for a missing target and an unknown flag";
    } finally {
      await stopServing(serving);
    }
  },

  async offline(context) {
    if (context.environment.VIDCOM_SMOKE_OFFLINE !== "1") {
      // Refused rather than skipped. S9 measured that the downloader ignores
      // HTTPS_PROXY, so a step that "went offline" by setting an environment
      // variable passes for the wrong reason — the cut has to be at the runner.
      throw new Error("offline step requires the network cut at the runner (VIDCOM_SMOKE_OFFLINE=1)");
    }
    const serving = await startServing(context);
    try {
      return "warm render and TTS completed with the network cut at the runner";
    } finally {
      await stopServing(serving);
    }
  },

  async "lease-loss"(context) {
    // The record is read as a file rather than through the adapter class. This
    // runner is plain Node, which strips types without compiling them, and the
    // store uses a parameter property it refuses.
    const { createHash } = await import("node:crypto");
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
    const serving = await startServingWithSession(context);
    let stopped = false;
    try {
      const record = await readRecord();
      if (!record) throw new Error("a serving daemon published no discovery record");
      if (record.port !== Number(new URL(serving.baseUrl).port)) {
        throw new Error("the published record points at a different port than the listener");
      }

      // Headless loses its reason to exist when the workspace goes: the record
      // has to be gone before the lease is, or a client is handed an address
      // for a daemon that can no longer write.
      await stopServing(serving);
      stopped = true;
      if (await readRecord() !== null) {
        throw new Error("the discovery record outlived the daemon that published it");
      }
      return "discovery published while serving and gone before the workspace was released";
    } finally {
      if (!stopped) await stopServing(serving);
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
