import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPOSITORY_ROOT, runtimeInputPath } from "./artifact-layout.mjs";
import {
  copyContainedTree,
  hostPlatformTag,
  materializedTreeSha256,
  parseRuntimeInputsValue,
  prunePythonBuildTools,
} from "./stage-artifact-runtime.mjs";

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-runtime-inputs: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

async function sha256Of(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The version string a tool reports, not one we decide for it.
 *
 * Recording what the binary says about itself is the only claim that stays true
 * when somebody swaps the file: a version copied from a download page describes
 * the page, not the bytes that ended up here.
 */
export function reportedVersion(binary, pattern) {
  const result = spawnSync(binary, ["-version"], { encoding: "utf8" });
  if (result.status !== 0) {
    fail("the media binary would not report its version", {
      binary,
      cause: result.error?.message ?? result.stderr?.slice(0, 200),
    });
  }
  const found = pattern.exec(result.stdout);
  if (!found?.[1]) fail("could not read a version out of the binary's own output", { binary });
  return found[1];
}

export const FFMPEG_VERSION_PATTERN = /^ffmpeg version (\S+)/u;
export const FFPROBE_VERSION_PATTERN = /^ffprobe version (\S+)/u;

/**
 * Describes the runtime this machine is going to pack.
 *
 * Every digest is computed from the bytes on disk right now. Nothing here is
 * copied from a release page or a previous run: the point of the file is to be
 * the record that staging re-checks, so a value that was not measured would
 * make the check agree with itself and prove nothing.
 */
export async function buildRuntimeInputs(options) {
  const platform = options.platform ?? hostPlatformTag();
  const pythonRoot = path.resolve(options.pythonRoot);
  const pythonPath = path.resolve(options.pythonPath ?? path.join(pythonRoot, "bin", "python3"));
  const vieneuRoot = path.resolve(
    options.vieneuRoot ?? path.join(REPOSITORY_ROOT, "packages/adapter/sidecars/vieneu"),
  );
  const ffmpegPath = path.resolve(options.ffmpegPath);
  const ffprobePath = path.resolve(options.ffprobePath);
  const packagesPath = path.resolve(options.pythonPackagesPath);

  // Seams, so this can be exercised without a real FFmpeg and a real CPython on
  // the machine. Asking a binary what it is remains the default; a test that can
  // only run where those binaries happen to exist is a test that runs nowhere.
  const readVersion = options.readVersion ?? reportedVersion;
  const cpythonVersion = options.cpythonVersion ?? (() => {
    const result = spawnSync(pythonPath, ["-c", "import sys; print(sys.version.split()[0])"], {
      encoding: "utf8",
    });
    if (result.status !== 0) fail("the frozen interpreter would not run", { pythonPath });
    return result.stdout.trim();
  })();

  const inputs = {
    schemaVersion: 1,
    artifactVersion: options.artifactVersion,
    platform,
    ffmpegPath,
    ffmpegVersion: readVersion(ffmpegPath, FFMPEG_VERSION_PATTERN),
    ffmpegSha256: await sha256Of(ffmpegPath),
    ffprobePath,
    ffprobeVersion: readVersion(ffprobePath, FFPROBE_VERSION_PATTERN),
    ffprobeSha256: await sha256Of(ffprobePath),
    pythonRoot,
    pythonPath,
    // Reported by the interpreter itself unless the caller names it, because
    // `sys.version` does not carry the build tag.
    cpythonVersion,
    pythonSha256: await sha256Of(pythonPath),
    // Two tree digests, and they are genuinely different values: the frozen
    // root as installed, and what is left after the build tooling and bytecode
    // are pruned away. Writing the same digest twice made staging reject its
    // own correct output. Both are produced by running the very prune staging
    // runs, on a copy, so the pin describes the tree that ships rather than the
    // tree that was downloaded.
    pythonTreeSha256: await materializedTreeSha256(pythonRoot),
    pythonRuntimeTreeSha256: await prunedPythonTreeSha256(pythonRoot),
    pythonPackagesPath: packagesPath,
    pythonPackagesSha256: await sha256Of(packagesPath),
    vieneuRoot,
    vieneuWorkerSha256: await sha256Of(path.join(vieneuRoot, "worker.py")),
  };

  // Checked against the host, not against the value just written. There is no
  // cross-build (DR-1): the digests here describe binaries on this machine, so
  // a file claiming another platform would pin this machine's bytes under
  // somebody else's tag. Parsing with staging's own function also means a shape
  // this generator gets wrong fails here rather than three build steps later.
  parseRuntimeInputsValue(inputs, hostPlatformTag());
  return inputs;
}

/**
 * The digest of the Python tree as it will ship, not as it was installed.
 *
 * Pruning happens on a throwaway copy: the source tree stays whole so a rebuild
 * can prune it again, and computing the value any other way would mean
 * predicting what the prune removes instead of measuring it.
 */
export async function prunedPythonTreeSha256(pythonRoot) {
  const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-python-prune-"));
  try {
    const copy = path.join(scratch, "python");
    // The frozen interpreter is an installed tree, not one this build produced.
    await copyContainedTree(pythonRoot, copy, true);
    await prunePythonBuildTools(copy);
    return await materializedTreeSha256(copy);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function writeRuntimeInputs(options) {
  const inputs = await buildRuntimeInputs(options);
  const target = options.output ?? runtimeInputPath(inputs.platform);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(inputs, null, 2)}\n`, "utf8");
  return { target, inputs };
}

function commandLine(argv) {
  const options = {};
  const flags = new Map([
    ["--ffmpeg", "ffmpegPath"],
    ["--ffprobe", "ffprobePath"],
    ["--python-root", "pythonRoot"],
    ["--python", "pythonPath"],
    ["--python-packages", "pythonPackagesPath"],
    ["--vieneu-root", "vieneuRoot"],
    ["--artifact-version", "artifactVersion"],
    ["--cpython-version", "cpythonVersion"],
    ["--output", "output"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--")) {
      fail(`unknown or incomplete argument ${argv[index]}`, {
        usage: `build-runtime-inputs ${[...flags.keys()].join(" <path> ")} <value>`,
      });
    }
    options[key] = value;
    index += 1;
  }
  for (const required of ["ffmpegPath", "ffprobePath", "pythonRoot", "pythonPackagesPath", "artifactVersion"]) {
    if (!options[required]) fail(`missing required argument for ${required}`);
  }
  return options;
}

async function main(argv) {
  const { target, inputs } = await writeRuntimeInputs(commandLine(argv));
  process.stderr.write(
    `build-runtime-inputs: ${path.relative(REPOSITORY_ROOT, target)}`
    + ` (${inputs.platform}, ffmpeg ${inputs.ffmpegVersion}, cpython ${inputs.cpythonVersion})\n`,
  );
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch(() => {
    // `fail` already reported the reason and set the exit code.
  });
}
