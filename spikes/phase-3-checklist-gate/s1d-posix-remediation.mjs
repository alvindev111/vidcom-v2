// S1d — remediation for S1c. Does capture-then-kill-recorded-pids close the leak?
//
// S1c proved kill(-rootPid) leaves chrome-headless-shell alive, because Chromium
// puts itself in its own process group. The fix cannot be "kill the group harder";
// the group does not contain the leak. It has to be:
//
//   while running : poll the descendant closure and ACCUMULATE concrete pids and
//                   the distinct pgids they belong to
//   on abort      : kill every recorded pgid, then every recorded pid
//   verify        : probe every recorded pid with kill(pid, 0) — never a ppid walk,
//                   which reads empty after reparenting (S1c measurementTrap)
//
// This runs the same render, applies that algorithm, and reports survivors.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs");
const ITERATIONS = Number(process.env.S1D_ITERATIONS ?? 3);
const CAPTURE_INTERVAL_MS = 250;
const SWEEP_INTERVAL_MS = 100;
const MAX_SWEEPS = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processTable() {
  let out = "";
  try { out = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid=,comm="], { encoding: "utf8", maxBuffer: 16 << 20 }); }
  catch { return []; }
  return out.split("\n").map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], comm: m[4] } : null;
  }).filter(Boolean);
}

function descendants(table, rootPid) {
  const byParent = new Map();
  for (const row of table) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    for (const c of byParent.get(queue.shift()) ?? []) { found.push(c); queue.push(c.pid); }
  }
  return found;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function oneIteration(index, scratch) {
  const child = spawn(process.execPath, [
    cli, "render", path.join(repo, "projects/warm-grain"),
    "-c", "compositions/intro.html",
    "-o", path.join(scratch, `r${index}.mp4`),
    "--quality", "draft", "--workers", "1",
  ], { cwd: repo, detached: true, stdio: ["ignore", "ignore", "ignore"] });

  const rootPid = child.pid;
  let exited = false;
  child.once("close", () => { exited = true; });

  // CAPTURE PHASE — the part today's runner does not do at all.
  const capturedPids = new Map();   // pid -> comm
  const capturedGroups = new Set([rootPid]);
  const cancelAfterMs = 4000 + index * 2000;
  const deadline = Date.now() + cancelAfterMs;
  while (Date.now() < deadline && !exited) {
    for (const row of descendants(processTable(), rootPid)) {
      capturedPids.set(row.pid, row.comm.split("/").pop());
      capturedGroups.add(row.pgid);
    }
    await sleep(CAPTURE_INTERVAL_MS);
  }
  if (exited) return { index, skipped: "render finished before cancel" };
  if (capturedPids.size === 0) return { index, skipped: "no descendant observed" };

  // KILL PHASE — every recorded group, then every recorded pid.
  const killStarted = process.hrtime.bigint();
  for (const pgid of capturedGroups) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  for (const pid of capturedPids.keys()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  try { process.kill(rootPid, "SIGKILL"); } catch { /* gone */ }

  // VERIFY PHASE — direct pid probe, plus a late-arrival check so a process that
  // appeared after the last capture is not silently ignored.
  let sweeps = 0;
  let consecutiveEmpty = 0;
  let survivors = [];
  while (sweeps < MAX_SWEEPS) {
    sweeps += 1;
    for (const row of descendants(processTable(), rootPid)) {
      if (!capturedPids.has(row.pid)) { capturedPids.set(row.pid, row.comm.split("/").pop()); }
    }
    survivors = [...capturedPids.keys()].filter(isAlive);
    for (const pid of survivors) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    consecutiveEmpty = survivors.length === 0 ? consecutiveEmpty + 1 : 0;
    if (consecutiveEmpty >= 2) break;
    await sleep(SWEEP_INTERVAL_MS);
  }
  const totalMs = Number(process.hrtime.bigint() - killStarted) / 1e6;

  return {
    index, cancelAfterMs,
    capturedPidCount: capturedPids.size,
    capturedGroupCount: capturedGroups.size,
    distinctCommands: [...new Set(capturedPids.values())],
    sweeps,
    totalKillAndVerifyMs: +totalMs.toFixed(1),
    survivors,
    exhaustive: consecutiveEmpty >= 2,
  };
}

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s1d-"));
const runs = [];
for (let i = 0; i < ITERATIONS; i += 1) runs.push(await oneIteration(i, scratch));

const measured = runs.filter((r) => !r.skipped);
const sweepCounts = measured.map((r) => r.sweeps).sort((a, b) => a - b);
const leaking = measured.filter((r) => r.survivors.length > 0);

console.log(JSON.stringify({
  spike: "S1d",
  question: "Does capture-then-kill-recorded-pids close the leak S1c found?",
  iterations: ITERATIONS,
  measuredIterations: measured.length,
  runs,
  summary: {
    maxSweeps: sweepCounts.at(-1) ?? null,
    p95Sweeps: sweepCounts.length ? sweepCounts[Math.min(sweepCounts.length - 1, Math.ceil(sweepCounts.length * 0.95) - 1)] : null,
    leakingIterations: leaking.length,
    meanCapturedPids: measured.length ? +(measured.reduce((s, r) => s + r.capturedPidCount, 0) / measured.length).toFixed(1) : null,
    meanTotalMs: measured.length ? +(measured.reduce((s, r) => s + r.totalKillAndVerifyMs, 0) / measured.length).toFixed(1) : null,
  },
  verdict: measured.length === 0 ? "INCONCLUSIVE"
    : leaking.length === 0 ? "REMEDIATION_WORKS" : "REMEDIATION_INSUFFICIENT",
  residualRisk: "A process spawned between the final capture poll and the kill is still outside capturedPids. Bounded best-effort, exactly as R6.6b-i already states for Windows — it applies to POSIX too.",
}, null, 2));
