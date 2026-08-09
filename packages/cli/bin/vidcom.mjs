#!/usr/bin/env node
import { createRequire } from "node:module";

const platformPackage = process.platform === "darwin" && process.arch === "arm64"
  ? "@esbuild/darwin-arm64/bin/esbuild"
  : process.platform === "linux" && process.arch === "x64"
    ? "@esbuild/linux-x64/bin/esbuild"
    : process.platform === "win32" && process.arch === "x64"
      ? "@esbuild/win32-x64/esbuild.exe"
      : null;
if (!platformPackage) throw new Error(`the source loader is unavailable on ${process.platform}-${process.arch}`);

// tsx and HyperFrames currently use different esbuild versions. Configure the
// native binary owned by tsx before tsx itself is evaluated; the TS bootstrap
// replaces this with HyperFrames' binary before it imports the runtime graph.
const requireFromLauncher = createRequire(import.meta.url);
const tsxPackage = requireFromLauncher.resolve("tsx/package.json");
const esbuildPackage = createRequire(tsxPackage).resolve("esbuild/package.json");
process.env.ESBUILD_BINARY_PATH = createRequire(esbuildPackage).resolve(platformPackage);
process.env.ESBUILD_WORKER_THREADS = "0";

const { register } = await import("tsx/esm/api");

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  if (type === "ExperimentalWarning"
    && String(warning) === "SQLite is an experimental feature and might change at any time") return;
  emitWarning(warning, ...args);
};

register();
const { runBootstrappedCli } = await import("../src/boot.ts");
process.exitCode = await runBootstrappedCli(process.argv.slice(2));
