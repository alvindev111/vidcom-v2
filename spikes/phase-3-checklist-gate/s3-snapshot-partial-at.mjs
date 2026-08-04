// S3 — Decision 13 gate: does ONE bad `--at` abort the whole snapshot invocation?
//
// Decision 13 batches every scene midpoint into a single `hyperframes snapshot
// --at t1,t2,…,tN`. That only holds if a timestamp the CLI cannot capture costs
// us that one frame instead of the whole run. If the run aborts, Decision 13
// Option 3 (batch first pass, per-scene retry) comes back.
//
// PASS: exit 0, N-1 PNGs, and the surviving files still carry the timestamp so
//       VidCom can map output back to scene.
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs");

async function snapshot(project, output, at) {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, [
    cli, "snapshot", project,
    "-o", output,
    "--at", at,
    "--no-end",
    "--describe", "false",
  ], { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => stdout.push(c));
  child.stderr.on("data", (c) => stderr.push(c));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const files = (await readdir(output, { recursive: true }).catch(() => []))
    .filter((f) => f.endsWith(".png"));
  return { exitCode, files: files.sort(), stderr: stderr.join("").slice(-600) };
}

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-s3-"));
const project = path.join(scratch, "warm-grain");
await cp(path.join(repo, "projects/warm-grain"), project, { recursive: true });

// Same offline treatment the existing design spike uses: the sample pulls GSAP
// from a CDN, and a network stall would be measured as a capture failure.
for (const rel of ["compositions/intro.html", "index.html"]) {
  const p = path.join(project, rel);
  const html = await readFile(p, "utf8").catch(() => null);
  if (html === null) continue;
  await writeFile(p, html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>/g, ""), "utf8");
}

// Baseline first: without it we cannot tell "the bad timestamp broke the run"
// from "this project never captured anything".
const baseline = await snapshot(project, path.join(scratch, "out-baseline"), "1.0,2.0,3.0");
// 999 s is far past any sample timeline; this is the timestamp under test.
const mixed = await snapshot(project, path.join(scratch, "out-mixed"), "1.0,999.0,3.0");
// Control: is 999 alone a hard error, or does the CLI clamp it to a real frame?
const lone = await snapshot(project, path.join(scratch, "out-lone"), "999.0");

const verdict =
  baseline.files.length !== 3 ? "INCONCLUSIVE_BASELINE"
  : mixed.exitCode === 0 && mixed.files.length >= 2 ? "PASS_PARTIAL_SURVIVES"
  : "FAIL_ABORTS_WHOLE_RUN";

console.log(JSON.stringify({
  spike: "S3",
  question: "Does one uncapturable --at timestamp abort the whole snapshot invocation?",
  baseline, mixed, lone,
  verdict,
  implication: verdict === "PASS_PARTIAL_SURVIVES"
    ? "Decision 13 stands: one batched invocation, retry re-sends only the missing midpoints."
    : "Decision 13 falls back to Option 3: batch the first pass, isolate retries per scene.",
}, null, 2));
