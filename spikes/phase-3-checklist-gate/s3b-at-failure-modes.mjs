// S3b — S3 could not trigger the failure it set out to test.
//
// S3 assumed a timestamp past the end of the timeline would be uncapturable.
// It is not: `--at 999` returned exit 0 and wrote `frame-01-at-999s.png`. So
// the Decision 13 question ("does one bad --at abort the batch?") is still open,
// and a second question opened with it: what DOES the CLI reject, and what does
// it silently accept? The second one now matters more — a midpoint VidCom
// computes wrongly comes back as a frame, not as an error.
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs");

async function snapshot(project, output, at) {
  const stderr = [];
  const child = spawn(process.execPath, [
    cli, "snapshot", project, "-o", output,
    "--at", at, "--no-end", "--describe", "false",
  ], { cwd: repo, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderr.push(c));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const files = (await readdir(output, { recursive: true }).catch(() => []))
    .filter((f) => f.endsWith(".png")).sort();
  const tail = stderr.join("").split("\n").filter((l) => /error|invalid|fail/i.test(l)).slice(0, 2);
  return { exitCode, fileCount: files.length, files, errorLines: tail };
}

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s3b-"));
const project = path.join(scratch, "warm-grain");
await cp(path.join(repo, "projects/warm-grain"), project, { recursive: true });
for (const rel of ["compositions/intro.html", "index.html"]) {
  const p = path.join(project, rel);
  const html = await readFile(p, "utf8").catch(() => null);
  if (html === null) continue;
  await writeFile(p, html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>/g, ""), "utf8");
}

// Each case pairs two good timestamps with one suspect one, so a whole-run abort
// shows up as fileCount 0 while a per-timestamp skip shows up as fileCount 2.
const cases = [
  { name: "past_end", at: "1.0,999.0,3.0" },
  { name: "negative", at: "1.0,-5.0,3.0" },
  { name: "non_numeric", at: "1.0,abc,3.0" },
  { name: "empty_slot", at: "1.0,,3.0" },
  { name: "duplicate", at: "1.0,1.0,3.0" },
  { name: "all_good_control", at: "1.0,2.0,3.0" },
];

const results = {};
for (const testCase of cases) {
  results[testCase.name] = await snapshot(project, path.join(scratch, `out-${testCase.name}`), testCase.at);
}

const control = results.all_good_control.fileCount;
const rejecting = Object.entries(results).filter(([, r]) => r.exitCode !== 0).map(([n]) => n);
const aborting = Object.entries(results)
  .filter(([n, r]) => n !== "all_good_control" && r.exitCode === 0 && r.fileCount === 0)
  .map(([n]) => n);
const silentlyAccepted = Object.entries(results)
  .filter(([n, r]) => n !== "all_good_control" && n !== "duplicate" && r.exitCode === 0 && r.fileCount >= control)
  .map(([n]) => n);

console.log(JSON.stringify({
  spike: "S3b",
  question: "Which --at values does the CLI reject, and does rejecting one kill the batch?",
  controlFileCount: control,
  results,
  rejectingCases: rejecting,
  wholeRunAbortCases: aborting,
  silentlyAcceptedCases: silentlyAccepted,
  verdict: aborting.length === 0 ? "BATCH_SURVIVES_EVERY_TESTED_INPUT" : "BATCH_ABORTS_SEE_DECISION_13_OPTION_3",
  secondFinding: silentlyAccepted.length > 0
    ? `CLI silently produces a frame for: ${silentlyAccepted.join(", ")}. VidCom MUST validate midpoints against root duration before spawning — the CLI will not.`
    : "CLI rejects out-of-range input; VidCom-side validation is defence in depth rather than the only guard.",
}, null, 2));
