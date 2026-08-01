import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";

const spikeRoot = path.resolve(import.meta.dirname, "..");
const artifactRoot = path.join(
  spikeRoot,
  ".artifacts",
  "packaging-alternatives",
);
const bundledEntry = path.join(artifactRoot, "node-sea-entry.cjs");
const seaConfig = path.join(artifactRoot, "node-sea-config.json");
const seaBlob = path.join(artifactRoot, "node-sea.blob");
const executable = path.join(artifactRoot, "phase-0-node-sea");
const archive = path.join(artifactRoot, "native-runtime.tar.gz");
const manifest = path.join(artifactRoot, "native-runtime-manifest.txt");
const nodeExecutable =
  process.env.VIDCOM_SPIKE_NODE ??
  (process.env.NVM_BIN
    ? path.join(process.env.NVM_BIN, "node")
    : execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim());
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

if (!readFileSync(nodeExecutable).includes(`${seaFuse}:0`)) {
  throw new Error(
    `Node executable does not contain the SEA fuse: ${nodeExecutable}. Set VIDCOM_SPIKE_NODE to a self-contained Node binary.`,
  );
}

buildSync({
  absWorkingDir: spikeRoot,
  bundle: true,
  entryPoints: [path.join(import.meta.dirname, "node-sea-entry.ts")],
  format: "cjs",
  outfile: bundledEntry,
  platform: "node",
  target: "node24",
});

writeFileSync(
  seaConfig,
  `${JSON.stringify(
    {
      main: bundledEntry,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      assets: {
        "native-runtime.tar.gz": archive,
        "native-runtime-manifest.json": manifest,
      },
    },
    null,
    2,
  )}\n`,
);

execFileSync(nodeExecutable, ["--experimental-sea-config", seaConfig], {
  stdio: "inherit",
});
rmSync(executable, { force: true });
execFileSync(nodeExecutable, [
  "-e",
  "require('node:fs').copyFileSync(process.execPath, process.argv[1])",
  executable,
]);
chmodSync(executable, 0o755);

if (process.platform === "darwin") {
  execFileSync("codesign", ["--remove-signature", executable], {
    stdio: "inherit",
  });
}
execFileSync(
  path.join(spikeRoot, "node_modules", ".bin", "postject"),
  [
    executable,
    "NODE_SEA_BLOB",
    seaBlob,
    "--sentinel-fuse",
    seaFuse,
    ...(process.platform === "darwin"
      ? ["--macho-segment-name", "NODE_SEA"]
      : []),
  ],
  { stdio: "inherit" },
);
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", executable], {
    stdio: "inherit",
  });
}

console.log(executable);
