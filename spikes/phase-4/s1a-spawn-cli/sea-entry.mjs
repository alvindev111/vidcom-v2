/**
 * S1a — can a Node SEA run the HyperFrames CLI when `process.execPath` is the
 * artifact and there is no `node` on PATH?
 *
 * Three shapes, run one per invocation (the naive shape re-enters this same
 * binary, so running them in one process poisons the measurement):
 *
 *   naive   [process.execPath, cliPath, ...args]  — today's code, both at
 *           binary-probe.ts:98 (render) and :66 (Chromium path lookup).
 *   shim    [process.execPath, "--vidcom-node", cliPath, ...args] — the artifact
 *           re-enters as a Node host and dynamic-imports the CLI.
 *   sidecar [extractedNodeBinary, cliPath, ...args] — ship a Node runtime in the
 *           R5 archive.
 *
 * Usage:
 *   <bin> --vidcom-node <script> [args...]     run as a Node host
 *   <bin> --shape <naive|shim|sidecar> <cli> <projectOrNode> [cliArgs...]
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHIM_FLAG = "--vidcom-node";
const TIMEOUT_MS = Number(process.env.S1A_TIMEOUT_MS ?? 45_000);

async function runAsNodeHost() {
  const script = process.argv[3];
  // The CLI reads process.argv; make it see what `node <script> ...` would.
  process.argv = [process.argv[0], script, ...process.argv.slice(4)];
  await import(pathToFileURL(script).href);
}

function run(command, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ verdict: "TIMEOUT", ms: Date.now() - started, stdout: stdout.slice(0, 300), stderr: stderr.slice(0, 300) });
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ verdict: "SPAWN_ERROR", error: String(error.message), ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        verdict: code === 0 ? "OK" : "EXIT_NONZERO",
        code,
        ms: Date.now() - started,
        stdout: stdout.slice(-600),
        stderr: stderr.slice(-600),
      });
    });
  });
}

async function probe() {
  const shape = process.argv[3];
  const cliPath = process.argv[4];
  const third = process.argv[5];
  const cliArgs = process.argv.slice(6);
  const result = { shape, execPath: process.execPath, cwd: process.cwd() };

  if (shape === "naive") {
    result.result = await run(process.execPath, [cliPath, ...cliArgs]);
  } else if (shape === "shim") {
    result.result = await run(process.execPath, [SHIM_FLAG, cliPath, ...cliArgs]);
  } else if (shape === "sidecar") {
    result.result = await run(third, [cliPath, ...cliArgs]);
  } else {
    result.result = { verdict: "BAD_SHAPE" };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// Wrapped: Node SEA takes a CJS main and esbuild rejects top-level await there.
async function main() {
  if (process.argv[2] === SHIM_FLAG) return runAsNodeHost();
  if (process.argv[2] === "--shape") return probe();
  process.stderr.write(`S1A_UNEXPECTED_ENTRY argv=${JSON.stringify(process.argv)}\n`);
  process.exit(97);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exit(1);
});
