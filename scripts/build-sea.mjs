import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertBuildableTarget } from "./build-artifact.mjs";
import { BUNDLE_PATH } from "./build-cli-bundle.mjs";
import { MANIFEST_PATH, PACK_PATH } from "./build-frontend-pack.mjs";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SEA_DIRECTORY = path.join(REPOSITORY_ROOT, "dist", "sea");

/**
 * The exact postject the build uses.
 *
 * Pinned rather than floating: it edits the executable format directly, so a
 * version change is a change to the bytes shipped to users. It is invoked
 * through the package runner rather than declared as a dependency — it is a
 * build tool, and nothing in the product ever imports it.
 */
export const POSTJECT = "postject@1.0.0-alpha.6";

/** Node's own sentinel. The runtime looks for this exact fuse to find the blob. */
export const SEA_FUSE = "fce680ab2cc467b6e072b8b5df1996b2";
export const SEA_RESOURCE = "NODE_SEA_BLOB";
export const MACHO_SEGMENT = "NODE_SEA";

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-sea: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function run(name, command, args) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
  if (result.error) fail(`${name} could not start`, { command, cause: result.error.message });
  if (result.status !== 0) fail(`${name} failed`, { exitCode: result.status });
}

export function artifactPath(tag) {
  const name = process.platform === "win32" ? "vidcom.exe" : "vidcom";
  return path.join(REPOSITORY_ROOT, "dist", "artifact", tag, name);
}

/**
 * The SEA configuration, stated in full.
 *
 * `useCodeCache` and `useSnapshot` are off deliberately. Both bake in
 * V8-version-specific bytes, and a cache built by one Node and read by another
 * fails at start-up rather than falling back — the artifact embeds its own Node
 * binary, but the build machine's `node` is what writes the blob, so the two
 * are only the same version by convention.
 */
export function seaConfig() {
  // Relative to the working directory the blob step runs in, not to the
  // configuration file that holds them. Getting that backwards fails with
  // "Cannot read main script", which reads like a missing bundle.
  const fromRoot = (target) => path.relative(REPOSITORY_ROOT, target).split(path.sep).join("/");
  return {
    main: fromRoot(BUNDLE_PATH),
    output: fromRoot(path.join(SEA_DIRECTORY, "sea-prep.blob")),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    // The frontend rides along as assets rather than as a directory beside the
    // executable, which is the whole point: one file, nothing to unpack.
    assets: {
      "frontend-manifest.json": fromRoot(MANIFEST_PATH),
      "frontend.pack": fromRoot(PACK_PATH),
    },
  };
}

/**
 * Arguments postject needs for this platform.
 *
 * Mach-O keeps injected resources in a named segment, and without the segment
 * name the blob lands somewhere the runtime does not look — the executable
 * builds, runs, and then reports that it has no embedded main.
 */
export function postjectArguments(target, blob, platform = process.platform) {
  const args = [target, SEA_RESOURCE, blob, "--sentinel-fuse", `NODE_SEA_FUSE_${SEA_FUSE}`];
  if (platform === "darwin") args.push("--macho-segment-name", MACHO_SEGMENT);
  return args;
}

export function requiredInputs() {
  return [BUNDLE_PATH, MANIFEST_PATH, PACK_PATH];
}

export function assertInputsPresent(inputs = requiredInputs()) {
  for (const input of inputs) {
    if (!existsSync(input)) {
      fail("a build step before this one has not run", {
        missing: input,
        hint: "run build:artifact, which runs the bundle and the pack first",
      });
    }
  }
}

export async function buildSea(target) {
  const tag = assertBuildableTarget(target);
  assertInputsPresent();

  await mkdir(SEA_DIRECTORY, { recursive: true });
  const configPath = path.join(SEA_DIRECTORY, "sea-config.json");
  await writeFile(configPath, `${JSON.stringify(seaConfig(), null, 2)}\n`, "utf8");
  run("sea blob", process.execPath, ["--experimental-sea-config", configPath]);

  const output = artifactPath(tag);
  await mkdir(path.dirname(output), { recursive: true });
  // The Node that runs this build is the Node that ships. There is no
  // cross-build, so taking the running binary is both the simplest source and
  // the only one guaranteed to match the platform being built for.
  copyFileSync(process.execPath, output);
  chmodSync(output, 0o755);

  if (process.platform === "darwin") {
    // The copy carries the original signature, which no longer matches once a
    // segment is injected. Removing it first is what keeps the injection from
    // producing a binary the kernel refuses to start.
    run("remove signature", "codesign", ["--remove-signature", output]);
  }

  const blob = path.join(SEA_DIRECTORY, "sea-prep.blob");
  run("inject blob", "bunx", ["--yes", POSTJECT, ...postjectArguments(output, blob)]);

  if (process.platform === "darwin") {
    // An arm64 Mach-O with no valid signature is killed on launch, so this is
    // not a hardening step that can wait: without it the artifact does not run
    // at all on the machine that just built it.
    run("ad-hoc sign", "codesign", ["--sign", "-", "--force", output]);
  }

  return output;
}

async function main(argv) {
  const target = argv[0];
  const output = await buildSea(target);
  process.stderr.write(`build-sea: ${output}\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch(() => {
    // `fail` already reported the reason and set the exit code.
  });
}
