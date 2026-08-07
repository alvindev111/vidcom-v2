/**
 * Builds the S1b probe into a Node SEA, following the same recipe Phase 0 §0.1
 * settled on (esbuild → CJS, sea-config, postject, ad-hoc codesign).
 *
 * esbuild and postject come from the Phase 0 spike's node_modules on purpose:
 * this spike must not add dependencies to the product workspace.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = import.meta.dirname;
const repoRoot = path.resolve(here, "..", "..", "..");
const phase0 = path.join(repoRoot, "spikes", "phase-0");
const requireFromPhase0 = createRequire(path.join(phase0, "package.json"));
const { buildSync } = requireFromPhase0("esbuild");

const outDir = path.join(here, ".artifacts");
mkdirSync(outDir, { recursive: true });
const name = process.env.S1B_ENTRY ?? "sea-entry.mjs";
const tag = name.replace(/\.mjs$/, "");
const bundle = path.join(outDir, `${tag}.cjs`);
const seaConfig = path.join(outDir, `${tag}-sea-config.json`);
const seaBlob = path.join(outDir, `${tag}.blob`);
const executable = path.join(outDir, `${tag}-bin`);

const external = process.env.S1B_EXTERNAL ? process.env.S1B_EXTERNAL.split(",") : [];

const result = buildSync({
  absWorkingDir: repoRoot,
  bundle: true,
  entryPoints: [path.join(here, name)],
  format: "cjs",
  outfile: bundle,
  platform: "node",
  target: "node24",
  external,
  metafile: true,
  logLevel: "info",
});

const inputs = Object.keys(result.metafile.inputs);
writeFileSync(
  path.join(outDir, `${tag}-bundle-report.json`),
  `${JSON.stringify({
    bundleBytes: statSync(bundle).size,
    inputCount: inputs.length,
    external,
    hyperframesInputs: inputs.filter((i) => i.includes("@hyperframes")).length,
    linkedomInputs: inputs.filter((i) => i.includes("linkedom")).length,
    esbuildInputs: inputs.filter((i) => /(^|\/)esbuild/.test(i)),
  }, null, 2)}\n`,
);

const nodeExecutable = process.execPath;
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
if (!readFileSync(nodeExecutable).includes(`${seaFuse}:0`)) {
  throw new Error(`Node executable has no SEA fuse: ${nodeExecutable}`);
}

writeFileSync(seaConfig, `${JSON.stringify({
  main: bundle,
  output: seaBlob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
}, null, 2)}\n`);

execFileSync(nodeExecutable, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
rmSync(executable, { force: true });
execFileSync(nodeExecutable, [
  "-e",
  "require('node:fs').copyFileSync(process.execPath, process.argv[1])",
  executable,
]);
chmodSync(executable, 0o755);
if (process.platform === "darwin") {
  execFileSync("codesign", ["--remove-signature", executable], { stdio: "inherit" });
}
execFileSync(path.join(phase0, "node_modules", ".bin", "postject"), [
  executable,
  "NODE_SEA_BLOB",
  seaBlob,
  "--sentinel-fuse",
  seaFuse,
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
], { stdio: "inherit" });
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", executable], { stdio: "inherit" });
}

console.log(JSON.stringify({
  executable,
  executableBytes: statSync(executable).size,
  bundleBytes: statSync(bundle).size,
}, null, 2));
