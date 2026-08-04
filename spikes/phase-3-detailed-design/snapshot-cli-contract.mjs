import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-design-snapshot-"));
const project = path.join(scratch, "warm-grain");
const output = path.join(scratch, "scene-intro");

try {
  await cp(path.join(repo, "projects/warm-grain"), project, { recursive: true });
  const compositionPath = path.join(project, "compositions/intro.html");
  let html = await readFile(compositionPath, "utf8");
  html = html.replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>\s*<script>[\s\S]*?<\/script>/, "");
  await writeFile(compositionPath, html, "utf8");

  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, [
    path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs"),
    "snapshot", project,
    "-o", output,
    "--at", "1.5",
    "--no-end",
    "--describe", "false",
  ], { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const files = await readdir(output, { recursive: true }).catch(() => []);
  console.log(JSON.stringify({
    question: "Can HyperFrames snapshot capture one exact scene midpoint in an isolated output directory?",
    exitCode,
    files,
    stdoutTail: stdout.join("").trim().split(/\r?\n/).slice(-5),
    stderrTail: stderr.join("").trim().split(/\r?\n/).slice(-5),
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

