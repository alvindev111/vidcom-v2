import { execFileSync } from "node:child_process";
import path from "node:path";

const spikeRoot = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  spikeRoot,
  ".artifacts",
  "packaging-alternatives",
  "phase-0-bun-native-loader",
);

execFileSync(
  "bun",
  [
    "build",
    "--compile",
    path.join(import.meta.dirname, "bun-native-loader.ts"),
    "--outfile",
    executable,
  ],
  { stdio: "inherit" },
);

console.log(executable);
