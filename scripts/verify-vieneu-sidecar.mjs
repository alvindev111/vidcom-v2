import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Verifies the VieNeu sidecar's contract WITHOUT installing the speech engine.
//
// The engine is a multi-hundred-megabyte download, so CI does not install it —
// but everything around it is still checkable, and none of it was until this
// script existed: worker.py had never been executed at all. What is verified:
//
//   1. it compiles under the CI interpreter;
//   2. `--probe` on a machine with no engine reports `ready: false` on stdout as
//      valid JSON and exits 0, rather than crashing (VidCom reads that to decide
//      the provider is unavailable, so a crash reads as "installed but broken");
//   3. stdout carries only that JSON — `vidcom mcp` shares stdout with the MCP
//      protocol stream, and one stray print corrupts it;
//   4. synthesis refuses to run when `HF_HOME` is unset or relative, which is
//      what keeps a gigabyte of weights out of the current directory;
//   5. the interpreter name VidCom picks for this platform actually exists.

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const worker = path.join(repositoryRoot, "packages/adapter/sidecars/vieneu/worker.py");
const onWindows = process.platform === "win32";
// Must match `defaultVieNeuCommand` in packages/adapter/src/tts/vieneu-sidecar-path.ts.
const interpreter = onWindows ? "python" : "python3";

/** Runs the interpreter and returns its streams without throwing on a non-zero exit. */
async function run(args, options = {}) {
  try {
    const { stdout, stderr } = await executeFile(interpreter, args, {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const version = await run(["--version"]);
assert(version.code === 0, `${interpreter} is not runnable: ${version.stderr.trim()}`);
process.stdout.write(`interpreter: ${(version.stdout || version.stderr).trim()}\n`);

const cacheRoot = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-"));

// Bytecode goes to a temp prefix so compiling does not leave a __pycache__
// beside a directory that ships as an asset.
const compiled = await run(["-m", "py_compile", worker], {
  env: { PYTHONPYCACHEPREFIX: path.join(cacheRoot, "pycache") },
});
assert(compiled.code === 0, `worker.py does not compile: ${compiled.stderr.trim()}`);

const probe = await run([worker, "--probe"], { env: { HF_HOME: cacheRoot } });
assert(probe.code === 0, `--probe exited ${probe.code}: ${probe.stderr.trim()}`);
let reported;
try {
  reported = JSON.parse(probe.stdout);
} catch {
  throw new Error(`--probe did not write JSON to stdout: ${JSON.stringify(probe.stdout)}`);
}
assert(reported.schemaVersion === 1, "--probe reported an unexpected schema version");
assert(reported.ready === false, "--probe claimed the engine is ready without it installed");
assert(reported.gpu === false, "--probe claimed a GPU without torch installed");
assert(Array.isArray(reported.voices) && reported.voices.length === 0, "--probe reported voices with no engine");
// Exactly one JSON document and nothing else: a diagnostic belongs on stderr.
assert(probe.stdout.trim() === JSON.stringify(reported), "--probe wrote extra output to stdout");
assert(probe.stderr.includes("not ready"), "--probe did not explain the missing engine on stderr");

const requestPath = path.join(cacheRoot, "request.json");
await writeFile(requestPath, JSON.stringify({
  schemaVersion: 1,
  modelId: "vieneu-v3-turbo",
  device: "cpu",
  voice: "Phạm Tuyên",
  outputDir: cacheRoot,
  cues: [{ id: "intro", text: "Xin chào" }],
}), "utf8");
const responsePath = path.join(cacheRoot, "response.json");

for (const [label, value] of [["unset", undefined], ["relative", "models"]]) {
  const guarded = await run([worker, "--request", requestPath, "--response", responsePath], {
    env: { HF_HOME: value ?? "" },
  });
  assert(guarded.code === 1, `a ${label} HF_HOME should fail, got exit ${guarded.code}`);
  assert(
    /HF_HOME must/.test(guarded.stderr),
    `a ${label} HF_HOME should say why, got: ${guarded.stderr.trim()}`,
  );
  assert(guarded.stdout === "", `a ${label} HF_HOME wrote to stdout: ${JSON.stringify(guarded.stdout)}`);
}

const rejected = await run([worker, "--request", requestPath, "--response", responsePath], {
  env: { HF_HOME: cacheRoot },
});
assert(rejected.code === 1, "synthesis without the engine installed should fail");
assert(rejected.stdout === "", "a failed synthesis wrote to stdout");
await readFile(responsePath, "utf8").then(
  () => { throw new Error("a failed synthesis still wrote a response file"); },
  () => undefined,
);

process.stdout.write("VieNeu sidecar contract verified without the speech engine installed.\n");
