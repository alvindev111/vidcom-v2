// S1 (POSIX half) — §5.20 + §5.9 contract: awaited kill, then verify sweep.
//
// Decision 12 replaced the Job Object sidecar with "await the kill, then sweep
// until two consecutive empty passes". The number that decides D7 is the Windows
// one, and it cannot be taken here — `taskkill` is Windows-only. What CAN be
// taken here is the half that is not platform-specific and that Finding 6 says
// is broken today:
//   1. does a persistent cancel flag reach a running child at all, or only
//      after it exits on its own (Finding 6 measured 3102 ms)?
//   2. does the process group kill actually reach Chromium and FFmpeg?
//   3. how many sweeps does convergence take when the group IS the closure?
//
// A PASS here does not close S1. It closes the POSIX contract and leaves the
// Windows sweep count as the one open number.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform === "win32") {
  console.log(JSON.stringify({ spike: "S1", skipped: "run the Windows half on Windows CI" }));
  process.exit(0);
}

const repo = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs");
const ITERATIONS = Number(process.env.S1_ITERATIONS ?? 8);
const SWEEP_INTERVAL_MS = 100;   // PROCESS_VERIFY_SWEEP_INTERVAL_MS
const MAX_SWEEPS = 20;           // PROCESS_VERIFY_MAX_SWEEPS

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every live PID whose process-group id is `pgid`. The group is the closure we killed. */
function groupMembers(pgid) {
  const out = spawnSyncCapture("ps", ["-Ao", "pid=,pgid="]);
  const pids = [];
  for (const line of out.split("\n")) {
    const [pid, group] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && group === pgid) pids.push(pid);
  }
  return pids;
}

function spawnSyncCapture(command, args) {
  const { execFileSync } = require("node:child_process");
  try { return execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 << 20 }); }
  catch { return ""; }
}
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

async function oneIteration(index, scratch) {
  // `detached: true` is what makes the child a group leader, so pgid === pid.
  // This is the same flag NodeProcessRunner already sets on POSIX.
  const child = spawn(process.execPath, [
    cli, "render", path.join(repo, "projects/warm-grain"),
    "-c", "compositions/intro.html",
    "-o", path.join(scratch, `c${index}.mp4`),
    "--quality", "draft", "--workers", "1",
  ], { cwd: repo, detached: true, stdio: ["ignore", "ignore", "ignore"] });

  const rootPid = child.pid;
  const exited = new Promise((resolve) => child.once("close", () => resolve("exited")));

  // Cancel at a spread of moments so we sometimes hit Chromium startup and
  // sometimes hit steady-state encoding. Cancelling an idle process would
  // measure nothing.
  const cancelAfterMs = 3000 + (index % 4) * 2500;
  await sleep(cancelAfterMs);

  const observedBeforeKill = groupMembers(rootPid);
  if (observedBeforeKill.length === 0) {
    return { index, cancelAfterMs, skipped: "render already finished before cancel" };
  }

  const killStarted = process.hrtime.bigint();
  try { process.kill(-rootPid, "SIGKILL"); } catch { /* group already gone */ }
  // The awaited part: on POSIX this is the child's own close event, which is
  // what today's runner already waits for. Windows awaits `taskkill` instead.
  await Promise.race([exited, sleep(5000)]);
  const killAwaitedMs = Number(process.hrtime.bigint() - killStarted) / 1e6;

  const captured = new Set(observedBeforeKill);
  let sweeps = 0;
  let consecutiveEmpty = 0;
  let survivors = [];
  const sweepStarted = process.hrtime.bigint();
  while (sweeps < MAX_SWEEPS) {
    sweeps += 1;
    const live = groupMembers(rootPid);
    for (const pid of live) captured.add(pid);
    survivors = live;
    consecutiveEmpty = live.length === 0 ? consecutiveEmpty + 1 : 0;
    if (consecutiveEmpty >= 2) break;
    await sleep(SWEEP_INTERVAL_MS);
  }
  const sweepMs = Number(process.hrtime.bigint() - sweepStarted) / 1e6;

  return {
    index, cancelAfterMs,
    observedBeforeKill: observedBeforeKill.length,
    capturedPids: captured.size,
    killAwaitedMs: +killAwaitedMs.toFixed(1),
    sweeps,
    sweepMs: +sweepMs.toFixed(1),
    survivors,
    exhaustive: consecutiveEmpty >= 2,
  };
}

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s1-"));
const runs = [];
for (let i = 0; i < ITERATIONS; i += 1) runs.push(await oneIteration(i, scratch));

const measured = runs.filter((r) => !r.skipped);
const sweepCounts = measured.map((r) => r.sweeps).sort((a, b) => a - b);
const p95 = sweepCounts.length ? sweepCounts[Math.min(sweepCounts.length - 1, Math.ceil(sweepCounts.length * 0.95) - 1)] : null;
const notExhaustive = measured.filter((r) => !r.exhaustive).length;
const withSurvivors = measured.filter((r) => r.survivors.length > 0).length;

console.log(JSON.stringify({
  spike: "S1-posix",
  platform: process.platform,
  question: "On POSIX, does an awaited group kill converge, and in how many sweeps?",
  iterations: ITERATIONS,
  measuredIterations: measured.length,
  runs,
  summary: {
    sweepsP95: p95,
    maxSweeps: sweepCounts.at(-1) ?? null,
    notExhaustiveCount: notExhaustive,
    survivorCount: withSurvivors,
    meanKillAwaitedMs: measured.length
      ? +(measured.reduce((s, r) => s + r.killAwaitedMs, 0) / measured.length).toFixed(1) : null,
    meanCapturedPids: measured.length
      ? +(measured.reduce((s, r) => s + r.capturedPids, 0) / measured.length).toFixed(1) : null,
  },
  verdict: measured.length === 0 ? "INCONCLUSIVE_NO_ITERATION_REACHED_CANCEL"
    : (p95 <= 5 && notExhaustive === 0 && withSurvivors === 0) ? "PASS_POSIX"
    : "FAIL_POSIX",
  stillOpen: "Windows sweep count and awaited `taskkill` latency — Windows CI only (D7).",
}, null, 2));
