import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MARKERS = Object.freeze([
  "P17_TREE_SOAK_SAMPLE",
  "P17_CATALOG_SOAK_SAMPLE",
  "P15_MUTATION_HISTORY_SAMPLE",
  "P15_SSE_SUSPENDED_SAMPLE",
  "P15_PTY_SUSPENDED_SAMPLE",
  "P14_ASSET_RANGE_SAMPLE",
  "ASSET_STREAM_LISTENER_SAMPLE",
]);
const TESTS = Object.freeze([
  "tests/soak/resource-soak.test.ts",
  "tests/server/mutation-history-lifecycle.test.ts",
  "tests/server/events.test.ts",
  "tests/server/agent-terminal-routes.test.ts",
  "tests/adapter/asset-range-stream.test.ts",
  "tests/server/asset-streaming-listener.test.ts",
]);

export function collectSoakSamples(output) {
  const samples = Object.fromEntries(MARKERS.map((marker) => [marker, []]));
  for (const line of output.split(/\r?\n/u)) {
    for (const marker of MARKERS) {
      const prefix = `${marker} `;
      if (!line.startsWith(prefix)) continue;
      try {
        const value = JSON.parse(line.slice(prefix.length));
        if (value && typeof value === "object" && !Array.isArray(value)) samples[marker].push(value);
      } catch {
        // The missing marker gate below turns malformed evidence into a failure.
      }
    }
  }
  return samples;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sourceIdentity() {
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "",
  };
}

function runVitest(profile) {
  const args = [
    "--expose-gc",
    path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--maxWorkers=1",
    ...TESTS,
  ];
  const timeoutMs = profile === "release" ? 45 * 60_000 : 15 * 60_000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, VIDCOM_SOAK_PROFILE: profile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout.push(chunk); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr.push(chunk); process.stderr.write(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function main() {
  const profile = option("--profile") ?? "presubmit";
  if (profile !== "presubmit" && profile !== "release") {
    throw new Error("--profile must be presubmit or release");
  }
  const outputDirectory = path.resolve(option("--output") ?? path.join(ROOT, ".artifacts", "resource-soak"));
  const startedAt = new Date();
  const source = sourceIdentity();
  const expected = process.env.VIDCOM_EXPECTED_GIT_SHA?.trim() || null;
  const result = await runVitest(profile);
  const samples = collectSoakSamples(result.stdout);
  const missingMarkers = MARKERS.filter((marker) => samples[marker].length === 0);
  const sourceMatches = expected === null || (source.commit === expected && !source.dirty);
  const status = result.code === 0 && !result.timedOut && missingMarkers.length === 0 && sourceMatches
    ? "passed"
    : "failed";
  const report = {
    version: 1,
    profile,
    status,
    source: { ...source, expected },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    timeoutMs: profile === "release" ? 45 * 60_000 : 15 * 60_000,
    tests: TESTS,
    process: { exitCode: result.code, timedOut: result.timedOut },
    missingMarkers,
    samples,
    stderrTail: result.stderr.slice(-4_000),
  };
  await mkdir(outputDirectory, { recursive: true });
  const reportPath = path.join(outputDirectory, `resource-soak-${profile}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`RESOURCE_SOAK_REPORT ${JSON.stringify({ reportPath, status, profile, missingMarkers })}\n`);
  if (status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
