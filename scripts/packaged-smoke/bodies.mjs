import { spawn, spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
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
    if (cold.status !== 0) {
      throw new Error(`cold doctor --repair exited ${String(cold.status)}: ${cold.stderr.trim().slice(0, 400)}`);
    }

    const warmStartedAt = Date.now();
    const warm = expectSuccess("warm doctor --deep", runArtifact(context, ["doctor", "--deep", "--json"]));
    const warmMs = Date.now() - warmStartedAt;
    const report = parseJson("doctor --deep", warm.stdout);
    const notOk = (report.items ?? []).filter((item) => item.status !== "ok");
    if (notOk.length > 0) {
      throw new Error(`warm doctor is not clean: ${notOk.map((item) => `${item.id}=${item.status}`).join(", ")}`);
    }
    context.measurements.coldMs = coldMs;
    context.measurements.warmMs = warmMs;
    return `version ${version.vidcom}/${version.runtimeManifest}; cold ${String(coldMs)}ms, warm ${String(warmMs)}ms`;
  },

  async "ui-lifecycle"(context) {
    const serving = await startServing(context);
    try {
      const health = await fetch(`${serving.baseUrl}/api/v1/health`);
      if (!health.ok) throw new Error(`health returned ${String(health.status)}`);
      const nonce = /token=(\S+)/u.exec(serving.output())?.[1];
      if (!nonce) throw new Error("serve did not mint a one-time token for the browser hand-off");

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
        body: JSON.stringify({ name: "Smoke", preset: "vertical-shorts" }),
      });
      if (!created.ok) throw new Error(`creating a project returned ${String(created.status)}`);
      context.session = { baseUrl: serving.baseUrl, cookie };
      return `served on ${serving.baseUrl}; nonce exchanged and a project created`;
    } finally {
      await stopServing(serving);
    }
  },

  import(context) {
    void context;
    throw new NotWrittenYet("import", "a fixture outside the workspace, copied in and backfilled");
  },

  async bridge(context) {
    const serving = await startServing(context);
    try {
      // stdout is the JSON-RPC channel, so anything else on it ends the session
      // rather than degrading it. This is the half that can be checked without
      // driving a full agent conversation; the rest waits with the others.
      const bridge = runArtifact(context, ["mcp", "--help"], { timeoutMs: 60_000 });
      if (bridge.stdout.trim() !== "" && !bridge.stdout.trim().startsWith("{")) {
        throw new Error(`the bridge wrote non-protocol output to stdout: ${bridge.stdout.trim().slice(0, 120)}`);
      }
      throw new NotWrittenYet("bridge", "an agent attaching while the UI daemon is live, across a restart");
    } finally {
      await stopServing(serving);
    }
  },

  "render-media"(context) {
    void context;
    throw new NotWrittenYet("render-media", "TTS, snapshot, render, and an ffprobe check for an audio stream");
  },

  "upload-and-progress"(context) {
    void context;
    throw new NotWrittenYet("upload-and-progress", "a 20 MB upload and SSE progress through the packaged host");
  },

  "render-cli"(context) {
    void context;
    throw new NotWrittenYet("render-cli", "render wait, --detach, and cancel mid-render");
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

  "lease-loss"(context) {
    void context;
    throw new NotWrittenYet("lease-loss", "writes refused, discovery dropped, and both degrade paths");
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
