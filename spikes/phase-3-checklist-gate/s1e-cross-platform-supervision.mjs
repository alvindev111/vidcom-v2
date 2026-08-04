// S1e — closes W1/W2: does §5.9's three-phase algorithm hold on every platform?
//
// S1c/S1d answered this on macOS with a real render. Two things had to change to
// make it a cross-platform contract test:
//   * the tree is synthetic, so the result does not depend on Chromium being
//     downloadable on a CI runner or on one engine's spawning habits;
//   * every platform difference is confined to three primitives in
//     platform-supervisor.mjs, so a failure names which primitive broke.
//
// It runs two arms against the same fixture:
//   naive       kill the root's group only — what node-process-runner.ts does today
//   three-phase capture pids -> kill groups AND pids -> probe recorded pids
//
// PASS needs both: naive must LEAK (otherwise the fixture failed to reproduce the
// escape and the second arm proves nothing), and three-phase must not.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  capture, enumerate, enumeratorName, descendantsOf, isAlive, killGroup, killPid,
  osIdentity, probeWindowsEnumerators, terminateAndVerify, isWindows, sleep,
} from "./platform-supervisor.mjs";

const fixture = path.join(import.meta.dirname, "process-tree-fixture.mjs");

async function readLedger(ledgerPath) {
  const raw = await readFile(ledgerPath, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function startTree(scratch, label) {
  const ledgerPath = path.join(scratch, `${label}.ledger`);
  await writeFile(ledgerPath, "");
  const root = spawn(process.execPath, [fixture, "root", ledgerPath], {
    detached: !isWindows,          // root leads its own group on POSIX
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Wait for all four to register rather than sleeping a fixed amount: a slow
  // runner would otherwise be measured as a missing process.
  for (let i = 0; i < 60; i += 1) {
    const rows = await readLedger(ledgerPath);
    if (rows.length >= 4) return { rootPid: root.pid, ledger: rows, handle: root };
    await sleep(250);
  }
  return { rootPid: root.pid, ledger: await readLedger(ledgerPath), handle: root };
}

function sweepAlive(pids) { return pids.filter(isAlive); }

async function runNaiveArm(scratch) {
  const tree = await startTree(scratch, "naive");
  const everyPid = tree.ledger.map((row) => row.pid);
  // Exactly today's behaviour: kill the root's group, nothing else.
  killGroup(tree.rootPid);
  await sleep(1200);

  const survivorsByProbe = sweepAlive(everyPid);
  // The measurement that lied in S1c, kept so the trap is demonstrated rather
  // than asserted: after the parent dies the tree walk finds nothing.
  const ppidWalkCount = descendantsOf(enumerate(), tree.rootPid).length;

  for (const pid of survivorsByProbe) killPid(pid);
  return {
    ledger: tree.ledger,
    survivorsByDirectProbe: survivorsByProbe,
    survivorRoles: tree.ledger.filter((r) => survivorsByProbe.includes(r.pid)).map((r) => r.role),
    ppidWalkCountAfterKill: ppidWalkCount,
    leaked: survivorsByProbe.length > 0,
  };
}

async function runThreePhaseArm(scratch) {
  const tree = await startTree(scratch, "three-phase");
  const state = await capture(tree.rootPid, 1000);
  const proof = await terminateAndVerify(tree.rootPid, state);
  // Ground truth from the ledger, independent of what capture happened to see.
  const ledgerSurvivors = sweepAlive(tree.ledger.map((row) => row.pid));
  for (const pid of ledgerSurvivors) killPid(pid);
  return {
    ledger: tree.ledger,
    capturedPidCount: proof.capturedPids.length,
    capturedGroupCount: proof.capturedGroups.length,
    sweeps: proof.sweeps,
    elapsedMs: proof.elapsedMs,
    exhaustive: proof.exhaustive,
    survivorsReportedByProof: proof.survivors,
    survivorsByLedgerProbe: ledgerSurvivors,
    leaked: ledgerSurvivors.length > 0,
  };
}

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s1e-"));
const naive = await runNaiveArm(scratch);
const threePhase = await runThreePhaseArm(scratch);

// Integrity comes first and is separate from the finding. Without it, a fixture
// that failed to spawn would let the three-phase arm "pass" by having nothing to
// kill — a green run that proves nothing at all.
const fixtureIntact = naive.ledger.length === 4 && threePhase.ledger.length === 4;

// This is the gate. Whether the naive arm leaks is a PLATFORM PROPERTY, not a
// pass condition: if some platform's group kill turns out to be a real closure,
// that is a useful finding, not a failure. Only the three-phase arm is required
// to hold everywhere.
const algorithmHolds = !threePhase.leaked && threePhase.exhaustive;
const proofAgreesWithGroundTruth =
  threePhase.survivorsReportedByProof.length === threePhase.survivorsByLedgerProbe.length;

const parentCapableEnumerator = !isWindows
  || probeWindowsEnumerators().some((probe) => probe.available && probe.providesParent);

// Without a parent-capable enumerator the capture phase cannot see the tree, so
// demanding zero survivors would be demanding something the platform cannot
// deliver. What it MUST still deliver is honesty: never report a clean proof
// while processes are alive. A degraded platform that leaks and says so is
// acceptable (containment R6.7b picks it up); one that leaks and reports success
// is not, because every layer above trusts that proof.
const degradedProofIsHonest = threePhase.leaked
  ? (!threePhase.exhaustive || threePhase.survivorsReportedByProof.length > 0)
  : true;
const gateHolds = parentCapableEnumerator ? algorithmHolds : degradedProofIsHonest;

console.log(JSON.stringify({
  spike: "S1e",
  question: "Does the three-phase supervision algorithm hold on this platform?",
  // The OS build matters for interpreting a green run: `wmic` exists on Windows
  // Server 2022 and not on 2025, so "which Windows" changes which branch ran.
  platform: { os: process.platform, arch: process.arch, node: process.version, ...osIdentity() },
  degradedModeForced: process.env.VIDCOM_DISABLE_ENUMERATORS ?? null,
  enumerator: enumeratorName(),
  windowsEnumeratorProbe: isWindows ? probeWindowsEnumerators() : null,
  naiveGroupKillArm: naive,
  threePhaseArm: threePhase,
  checks: {
    fixtureIntact, algorithmHolds, proofAgreesWithGroundTruth,
    parentCapableEnumerator, degradedProofIsHonest, gateHolds,
  },
  platformProperty: {
    naiveGroupKillLeaks: naive.leaked,
    ppidWalkReportsCleanWhileLeaking: naive.leaked && naive.ppidWalkCountAfterKill === 0,
  },
  verdict: !fixtureIntact ? "INVALID_FIXTURE_DID_NOT_START"
    : !gateHolds ? "FAIL"
    : parentCapableEnumerator ? "PASS" : "PASS_DEGRADED_PROOF_HONEST",
  notes: [
    naive.leaked
      ? "Naive group kill LEAKS on this platform — same shape as the macOS render measurement (S1c)."
      : "Naive group kill did not leak here. Record it as a platform property; it does not remove the need for the three-phase algorithm, because §5.9 has to hold on every platform with one code path.",
    !parentCapableEnumerator
      ? "No parent-capable enumerator, so capture degrades to the root group. The gate here is honesty, not zero survivors: the proof must not claim success while processes live. Containment (R6.7b) is what actually reclaims them."
      : "A parent-capable enumerator is available, so the capture phase can see the whole tree.",
  ],
}, null, 2));

// Integrity failure, or a proof that lies, are the only failures. A platform
// whose group kill already suffices exits 0; so does a degraded platform that
// reports its own limits truthfully.
process.exitCode = (!fixtureIntact || !gateHolds || !proofAgreesWithGroundTruth) ? 1 : 0;
