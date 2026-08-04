// S1b — is the POSIX process group actually the closure we think it is?
//
// S1 passed, but every iteration observed only ~2 PIDs in the group. A render
// runs Chromium and FFmpeg, so either they had not started yet at cancel time,
// or they are not group members — and the second case would mean `kill(-pgid)`
// leaves them alive while the sweep reports a clean, empty group. That failure
// mode reports PASS while leaking, which is the worst shape a proof can have.
//
// This samples a live render repeatedly and compares two sets:
//   group      = every live PID whose pgid == rootPid   (what kill(-pgid) hits)
//   descendant = transitive ppid closure from rootPid    (what actually must die)
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
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
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: +match[1], ppid: +match[2], pgid: +match[3], comm: match[4] } : null;
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

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s1b-"));
const child = spawn(process.execPath, [
  cli, "render", path.join(repo, "projects/warm-grain"),
  "-c", "compositions/intro.html",
  "-o", path.join(scratch, "probe.mp4"),
  "--quality", "draft", "--workers", "1",
], { cwd: repo, detached: true, stdio: ["ignore", "ignore", "ignore"] });

const rootPid = child.pid;
let done = false;
child.once("close", () => { done = true; });

const samples = [];
for (let i = 0; i < 30 && !done; i += 1) {
  await sleep(1000);
  const table = processTable();
  const kin = descendants(table, rootPid);
  const group = table.filter((row) => row.pgid === rootPid);
  const groupPids = new Set(group.map((row) => row.pid));
  const escaped = kin.filter((row) => !groupPids.has(row.pid));
  samples.push({
    atSecond: i + 1,
    descendantCount: kin.length,
    groupCount: group.length,
    escaped: escaped.map((row) => ({ pid: row.pid, pgid: row.pgid, comm: row.comm.slice(-40) })),
    comms: [...new Set(kin.map((row) => row.comm.split("/").pop().slice(0, 24)))],
  });
}

try { process.kill(-rootPid, "SIGKILL"); } catch { /* already gone */ }
await sleep(500);
const after = processTable();
const leaked = descendants(after, rootPid);

const everEscaped = samples.filter((s) => s.escaped.length > 0);
const peakDescendants = Math.max(0, ...samples.map((s) => s.descendantCount));

console.log(JSON.stringify({
  spike: "S1b",
  question: "Do render descendants stay inside the process group that kill(-pgid) targets?",
  rootPid,
  samplesTaken: samples.length,
  peakDescendants,
  distinctCommands: [...new Set(samples.flatMap((s) => s.comms))],
  samplesWithEscapedDescendants: everEscaped.length,
  escapedExamples: everEscaped.slice(0, 3),
  survivorsAfterGroupKill: leaked.map((row) => ({ pid: row.pid, comm: row.comm.slice(-40) })),
  verdict: everEscaped.length === 0 && leaked.length === 0
    ? "GROUP_IS_THE_CLOSURE"
    : "GROUP_IS_NOT_THE_CLOSURE_SEE_NOTES",
  note: peakDescendants <= 2
    ? "Peak descendant count stayed low — check distinctCommands before concluding the render ever reached Chromium/FFmpeg."
    : "Render reached a multi-process stage, so the comparison is meaningful.",
}, null, 2));
