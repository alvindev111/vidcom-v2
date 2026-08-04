// S1c — the decisive POSIX test. Does kill(-pgid) actually kill Chromium?
//
// S1b showed chrome-headless-shell running under its OWN pgid, so kill(-rootPid)
// never targets it. S1's PASS was therefore a false pass: it swept for group
// members, and the leak is by definition not a group member.
//
// The survivor check must also not walk ppid. Once the render parent dies its
// children are reparented to pid 1, so a ppid walk from rootPid returns an empty
// set whether the leak happened or not — a measurement that reads "clean" in
// exactly the case we are hunting. So: record the concrete PIDs while they are
// alive, kill the group, then probe those exact PIDs with kill(pid, 0).
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs");
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
    for (const child of byParent.get(queue.shift()) ?? []) { found.push(child); queue.push(child.pid); }
  }
  return found;
}

/** Liveness of a concrete pid, independent of who its parent now is. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s1c-"));
const child = spawn(process.execPath, [
  cli, "render", path.join(repo, "projects/warm-grain"),
  "-c", "compositions/intro.html",
  "-o", path.join(scratch, "probe.mp4"),
  "--quality", "draft", "--workers", "1",
], { cwd: repo, detached: true, stdio: ["ignore", "ignore", "ignore"] });

const rootPid = child.pid;
let exited = false;
child.once("close", () => { exited = true; });

// Wait until the render has actually reached its multi-process stage; killing
// before Chromium exists would prove nothing.
let observed = [];
for (let i = 0; i < 25 && !exited; i += 1) {
  await sleep(1000);
  const table = processTable();
  const kin = descendants(table, rootPid);
  if (kin.some((row) => /chrome|ffmpeg/i.test(row.comm))) {
    observed = kin.map((row) => ({ pid: row.pid, pgid: row.pgid, comm: row.comm.split("/").pop() }));
    break;
  }
}

if (observed.length === 0) {
  console.log(JSON.stringify({ spike: "S1c", verdict: "INCONCLUSIVE_NEVER_SAW_CHROMIUM" }, null, 2));
  try { process.kill(-rootPid, "SIGKILL"); } catch { /* gone */ }
  process.exit(0);
}

const inGroup = observed.filter((p) => p.pgid === rootPid);
const outOfGroup = observed.filter((p) => p.pgid !== rootPid);

// Exactly what NodeProcessRunner does today on POSIX.
try { process.kill(-rootPid, "SIGKILL"); } catch { /* gone */ }
await sleep(1500);

const stillAlive = observed.filter((p) => isAlive(p.pid));
// The measurement that would have lied: walking ppid after the parent died.
const ppidWalkAfterKill = descendants(processTable(), rootPid).length;

// Leave nothing behind regardless of outcome.
for (const p of stillAlive) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }

console.log(JSON.stringify({
  spike: "S1c",
  question: "After kill(-pgid), are the render's Chromium/FFmpeg processes actually dead?",
  rootPid,
  observedDescendants: observed,
  inGroupCount: inGroup.length,
  outOfGroupCount: outOfGroup.length,
  survivorsByDirectPidProbe: stillAlive,
  ppidWalkAfterKillCount: ppidWalkAfterKill,
  verdict: stillAlive.length === 0 ? "GROUP_KILL_SUFFICES" : "GROUP_KILL_LEAKS",
  measurementTrap: stillAlive.length > 0 && ppidWalkAfterKill === 0
    ? "A ppid-based sweep would have reported ZERO survivors while processes were still alive. Any verify sweep MUST probe recorded PIDs directly."
    : "ppid walk and direct probe agreed on this run.",
  cleanedUp: stillAlive.map((p) => p.pid),
}, null, 2));
