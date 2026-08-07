/**
 * Packs `out/` into a SEA asset and builds the static host binary.
 * Same recipe as Phase 0 §0.1 and the S1 spikes.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = import.meta.dirname;
const repoRoot = path.resolve(here, "..", "..", "..");
const phase0 = path.join(repoRoot, "spikes", "phase-0");
const { buildSync } = createRequire(path.join(phase0, "package.json"))("esbuild");

const outDir = path.join(here, ".artifacts");
mkdirSync(outDir, { recursive: true });

const exported = path.join(here, "out");
const files = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files[path.relative(exported, full).split(path.sep).join("/")] = readFileSync(full).toString("base64");
  }
};
walk(exported);
const filesJson = path.join(outDir, "files.json");
writeFileSync(filesJson, JSON.stringify(files));

const bundle = path.join(outDir, "host.cjs");
buildSync({
  absWorkingDir: here,
  bundle: true,
  entryPoints: [path.join(here, "host-entry.mjs")],
  format: "cjs",
  outfile: bundle,
  platform: "node",
  target: "node24",
  external: ["node:sea"],
});

const seaConfig = path.join(outDir, "host-sea-config.json");
const seaBlob = path.join(outDir, "host.blob");
const executable = path.join(outDir, "s2-host");
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

writeFileSync(seaConfig, `${JSON.stringify({
  main: bundle,
  output: seaBlob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: { "files.json": filesJson },
}, null, 2)}\n`);

execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
rmSync(executable, { force: true });
execFileSync(process.execPath, [
  "-e",
  "require('node:fs').copyFileSync(process.execPath, process.argv[1])",
  executable,
]);
chmodSync(executable, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable], { stdio: "inherit" });
execFileSync(path.join(phase0, "node_modules", ".bin", "postject"), [
  executable, "NODE_SEA_BLOB", seaBlob, "--sentinel-fuse", seaFuse,
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
], { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", executable], { stdio: "inherit" });

console.log(JSON.stringify({
  executable,
  executableBytes: statSync(executable).size,
  embeddedFiles: Object.keys(files).length,
  embeddedBytes: statSync(filesJson).size,
}, null, 2));
