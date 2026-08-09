// S1f — the one question the synthetic fixture cannot answer.
//
// S1e proves the algorithm handles a descendant that leaves the root's process
// group, using four Node processes. What it does NOT prove is how
// `chrome-headless-shell` behaves on Windows: it may leave the group like it does
// on macOS (S1b), or it may put itself in a Job Object with a breakaway flag, or
// `taskkill /T` may already reach it. Each of those changes what §5.9 has to do,
// and none of them is visible from a Node fixture.
//
// So this runs a real render, observes the real tree, kills it with the real
// algorithm, and verifies by direct pid probe. It is written to run on any
// platform — the CI job is Windows because that is the gap, but running it on
// Linux or macOS is a valid way to compare.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  capture, descendantsOf, enumerate, enumeratorName, killGroup, killPid,
  osIdentity, probeWindowsEnumerators, terminateAndVerify, isWindows, sleep,
} from "./platform-supervisor.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs");

function startRender(outputPath) {
  return spawn(process.execPath, [
    cli, "render", path.join(repo, "projects/warm-grain"),
    "-c", "compositions/intro.html",
    "-o", outputPath,
    "--quality", "draft", "--workers", "1",
  ], { cwd: repo, detached: !isWindows, stdio: ["ignore", "ignore", "ignore"] });
}

/** Poll until the render has actually reached its multi-process stage. */
async function waitForEngine(rootPid, isRunning) {
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    if (!isRunning()) return null;
    const kin = descendantsOf(enumerate(), rootPid);
    if (kin.some((row) => /chrome|ffmpeg/i.test(row.name ?? ""))) return kin;
    // Without names in the enumerator output (tasklist-only Windows), fall back
    // to "more than one descendant" as the signal that the engine has started.
    if (kin.length >= 2) return kin;
  }
  return null;
}

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s1f-"));
const child = startRender(path.join(scratch, "probe.mp4"));
const rootPid = child.pid;
let running = true;
child.once("close", () => { running = false; });

const observed = await waitForEngine(rootPid, () => running);
if (observed === null) {
  console.log(JSON.stringify({
    spike: "S1f",
    platform: osIdentity(),
    verdict: "INCONCLUSIVE_ENGINE_NEVER_OBSERVED",
    note: "The render finished or never reached a multi-process stage. Nothing can be concluded about descendant containment from this run.",
  }, null, 2));
  killGroup(rootPid); killPid(rootPid);
  process.exit(0);
}

// Ground truth recorded WHILE alive. After the parent dies these pids are
// reparented and no tree walk can find them again (S1c measurementTrap).
const groundTruth = observed.map((row) => ({
  pid: row.pid,
  pgid: row.pgid,
  name: row.name ?? "",
  startedAt: row.startedAt,
}));
const escaped = groundTruth.filter((row) => row.pgid !== null && row.pgid !== rootPid);

const state = await capture(rootPid, 1000);
const proof = await terminateAndVerify(rootPid, state);

await sleep(1000);
const currentIdentities = new Map(enumerate().map((row) => [row.pid, row.startedAt]));
const survivorsByGroundTruth = groundTruth.filter((row) =>
  row.startedAt !== null && currentIdentities.get(row.pid) === row.startedAt);
for (const row of survivorsByGroundTruth) killPid(row.pid);

const honest = survivorsByGroundTruth.length === 0
  || !proof.exhaustive
  || proof.survivors.length > 0;

console.log(JSON.stringify({
  spike: "S1f",
  question: "Does a REAL render's engine tree stay contained, and does the algorithm terminate it?",
  platform: { ...osIdentity(), node: process.version },
  enumerator: enumeratorName(),
  windowsEnumeratorProbe: isWindows ? probeWindowsEnumerators() : null,
  rootPid,
  groundTruthDescendants: groundTruth,
  descendantsOutsideRootGroup: escaped,
  engineLeavesRootProcessGroup: escaped.length > 0,
  proof: {
    capturedPids: proof.capturedPids.length,
    capturedGroups: proof.capturedGroups.length,
    sweeps: proof.sweeps,
    elapsedMs: proof.elapsedMs,
    exhaustive: proof.exhaustive,
    survivors: proof.survivors,
  },
  survivorsByGroundTruthProbe: survivorsByGroundTruth,
  verdict: survivorsByGroundTruth.length === 0 ? "TERMINATED_CLEAN"
    : honest ? "LEAKED_BUT_PROOF_HONEST" : "LEAKED_AND_PROOF_LIED",
  note: escaped.length > 0
    ? "The engine leaves the root's process group here too — same as macOS, so the capture phase is load-bearing on this platform."
    : "Every descendant stayed in the root's group on this platform. Record it; it does not license dropping the capture phase, since one code path has to hold everywhere.",
}, null, 2));

// A proof that lied is the only hard failure: a leak the proof admits is handled
// by containment (R6.7b), a leak it hides is not handled by anything.
process.exitCode = honest ? 0 : 1;
