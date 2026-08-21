import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPOSITORY_ROOT } from "./artifact-layout.mjs";
import { assertDecoders, assertEncoders } from "./build-ffmpeg.mjs";
import { readReleaseMediaProvenance } from "./build-release-media.mjs";
import { writeRuntimeInputs } from "./build-runtime-inputs.mjs";
import { hostPlatformTag } from "./stage-artifact-runtime.mjs";

// CI smoke fixture only. These digest-pinned binaries exercise the native
// artifact on all three runner OSes, but they are not an approved production
// acquisition source and MUST NOT be used to publish a release.
const SMOKE_FIXTURE_RELEASE_ROOT = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const CPYTHON_RELEASE_ROOT = "https://github.com/astral-sh/python-build-standalone/releases/download/20260805";
const EVIDENCE_ROOT = path.join(
  REPOSITORY_ROOT,
  "spikes/phase-4/s9-windows-runtime/evidence",
);
const PRUNE_PACKAGES = [
  "fastapi", "gradio", "gradio_client", "groovy", "hf-gradio", "llvmlite",
  "markdown-it-py", "mdurl", "numba", "pillow", "pygments", "python-multipart",
  "rich", "safehttpx", "scikit-learn", "semantic-version", "shellingham",
  "starlette", "tomlkit", "typer", "uvicorn",
];

/** Download inputs are immutable only when both their location and bytes are pinned. */
export const PACKAGED_RUNTIME_SOURCES = Object.freeze({
  "darwin-arm64": Object.freeze({
    python: Object.freeze({
      url: `${CPYTHON_RELEASE_ROOT}/cpython-3.12.13%2B20260805-aarch64-apple-darwin-install_only_stripped.tar.gz`,
      sha256: "sha256:a4b36035915038104aabee94d6f02827161da444296881fe4493cb98f70304b2",
    }),
    ffmpeg: Object.freeze({
      url: `${SMOKE_FIXTURE_RELEASE_ROOT}/ffmpeg-darwin-arm64.gz`,
      sha256: "sha256:8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    }),
    ffprobe: Object.freeze({
      url: `${SMOKE_FIXTURE_RELEASE_ROOT}/ffprobe-darwin-arm64.gz`,
      sha256: "sha256:d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be",
    }),
    evidence: "darwin-package-set.txt",
  }),
  "linux-x64": Object.freeze({
    python: Object.freeze({
      url: `${CPYTHON_RELEASE_ROOT}/cpython-3.12.13%2B20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
      sha256: "sha256:f04a55ae95e8bd352cdff8da11c344fe609ec84795d106fa91b6620366d786fe",
    }),
    ffmpeg: Object.freeze({
      url: `${SMOKE_FIXTURE_RELEASE_ROOT}/ffmpeg-linux-x64.gz`,
      sha256: "sha256:bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
    }),
    ffprobe: Object.freeze({
      url: `${SMOKE_FIXTURE_RELEASE_ROOT}/ffprobe-linux-x64.gz`,
      sha256: "sha256:25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067",
    }),
    evidence: "linux-package-set.txt",
  }),
  "win32-x64": Object.freeze({
    python: Object.freeze({
      url: `${CPYTHON_RELEASE_ROOT}/cpython-3.12.13%2B20260805-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
      sha256: "sha256:b304536477587bbb729322b77ac1c59bdb95706651ab2ef38cae0fec77ede00f",
    }),
    ffmpeg: Object.freeze({
      url: `${SMOKE_FIXTURE_RELEASE_ROOT}/ffmpeg-win32-x64.gz`,
      sha256: "sha256:8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
    }),
    ffprobe: Object.freeze({
      url: `${SMOKE_FIXTURE_RELEASE_ROOT}/ffprobe-win32-x64.gz`,
      sha256: "sha256:f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d",
    }),
    evidence: "win-package-set.txt",
  }),
});

function fail(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  throw new Error(`prepare-packaged-runtime: ${message}${suffix}`);
}

async function sha256Of(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function downloadPinned(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  if (await sha256Of(target).catch(() => null) === source.sha256) return target;
  await rm(target, { force: true });
  const response = await fetch(source.url);
  if (!response.ok) fail("download failed", { url: source.url, status: response.status });
  await writeFile(target, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
  const actual = await sha256Of(target);
  if (actual !== source.sha256) {
    await rm(target, { force: true });
    fail("download did not match its pinned digest", { url: source.url, expected: source.sha256, actual });
  }
  return target;
}

function run(name, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: REPOSITORY_ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    fail(`${name} failed`, { cause: result.error?.message, exitCode: result.status });
  }
  return options.capture ? result.stdout.trim() : "";
}

async function materializeMedia(source, archive, target) {
  await downloadPinned(source, archive);
  await writeFile(target, gunzipSync(await readFile(archive)), { flag: "wx", mode: 0o755 });
  await chmod(target, 0o755);
}

const PYTHON_PACKAGE_PROBE = String.raw`
import importlib.metadata as metadata
packages = {}
for distribution in metadata.distributions():
    name = (distribution.metadata.get("Name") or "").lower().replace("_", "-")
    version = distribution.version.strip()
    if name:
        if name in packages:
            raise RuntimeError(f"duplicate package {name}")
        packages[name] = version
pins = [f"{name}=={version}" for name, version in packages.items()]
print("\n".join(sorted(pins)))
`;

/**
 * Creates the exact-host native inputs consumed by build:artifact.
 *
 * Two media supply chains, and they are not interchangeable. `releaseMedia`
 * takes ffmpeg/ffprobe compiled here from the approved pinned upstream sources
 * (`build-release-media.mjs`); everything else takes the third-party smoke
 * fixture, which exercises the artifact on all three runner OSes and MUST NOT
 * be published (C-21). The opt-in stays on the fixture path alone, so choosing
 * the release path is not a way to route around it.
 */
export async function preparePackagedRuntime(options = {}) {
  const releaseMedia = options.releaseMedia === true
    ? await readReleaseMediaProvenance(options.releaseMediaRoot)
    : null;
  if (releaseMedia === null
    && options.allowUnreleasedSmokeRuntime !== true
    && process.env.VIDCOM_ALLOW_UNRELEASED_SMOKE_RUNTIME !== "1") {
    fail(
      "the cross-platform media inputs are smoke fixtures, not an approved release supply chain",
      { required: "VIDCOM_ALLOW_UNRELEASED_SMOKE_RUNTIME=1" },
    );
  }
  const platform = options.platform ?? hostPlatformTag();
  const source = PACKAGED_RUNTIME_SOURCES[platform];
  if (!source) fail("unsupported host", { platform });
  const artifactVersion = options.artifactVersion ?? "0.1.0-smoke";
  const outputRoot = path.resolve(
    options.outputRoot ?? path.join(REPOSITORY_ROOT, "dist", "runtime-prep", platform),
  );
  const cacheRoot = path.resolve(
    options.cacheRoot
      ?? process.env.VIDCOM_RUNTIME_SOURCE_CACHE
      ?? path.join(REPOSITORY_ROOT, ".vidcom-runtime-source-cache"),
  );
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const pythonArchive = await downloadPinned(
    source.python,
    path.join(cacheRoot, `${platform}-cpython.tar.gz`),
  );
  run("extract frozen Python", "tar", ["-xzf", pythonArchive, "-C", outputRoot]);
  const pythonRoot = path.join(outputRoot, "python");
  const pythonPath = platform === "win32-x64"
    ? path.join(pythonRoot, "python.exe")
    // python-build-standalone exposes `python3` as a symlink. Runtime staging
    // deliberately accepts a regular-file authority only, then publishes the
    // stable `python3` path inside the frozen tree itself.
    : path.join(pythonRoot, "bin", "python3.12");
  const evidencePath = path.join(EVIDENCE_ROOT, source.evidence);
  run("install exact VieNeu stack", pythonPath, [
    "-m", "pip", "install", "--disable-pip-version-check", "-r", evidencePath,
  ]);
  run("prune non-runtime Python packages", pythonPath, [
    "-m", "pip", "uninstall", "-y", ...PRUNE_PACKAGES,
  ]);
  run("remove pip from the shipped Python tree", pythonPath, ["-m", "pip", "uninstall", "-y", "pip"]);

  const pythonPackagesPath = path.join(outputRoot, "python-packages.txt");
  const packages = run(
    "enumerate pruned Python packages",
    pythonPath,
    ["-c", PYTHON_PACKAGE_PROBE],
    { capture: true },
  );
  await writeFile(pythonPackagesPath, `${packages}\n`, "utf8");
  run("probe frozen VieNeu imports", pythonPath, [
    "-c", "import vieneu, huggingface_hub, onnxruntime, numpy, librosa, soundfile",
  ]);

  const suffix = platform === "win32-x64" ? ".exe" : "";
  const ffmpegPath = path.join(outputRoot, `ffmpeg${suffix}`);
  const ffprobePath = path.join(outputRoot, `ffprobe${suffix}`);
  if (releaseMedia === null) {
    await materializeMedia(
      source.ffmpeg,
      path.join(cacheRoot, `${platform}-ffmpeg.gz`),
      ffmpegPath,
    );
    await materializeMedia(
      source.ffprobe,
      path.join(cacheRoot, `${platform}-ffprobe.gz`),
      ffprobePath,
    );
  } else {
    // Copied rather than referenced in place: the runtime inputs pin these
    // bytes by digest, and staging re-reads the files at that path. A path
    // pointing back into the build tree would pin something a later rebuild of
    // FFmpeg can change underneath a finished artifact.
    await copyFile(releaseMedia.ffmpegPath, ffmpegPath);
    await copyFile(releaseMedia.ffprobePath, ffprobePath);
    await chmod(ffmpegPath, 0o755);
    await chmod(ffprobePath, 0o755);
  }
  assertEncoders(ffmpegPath);
  assertDecoders(ffmpegPath);

  return writeRuntimeInputs({
    artifactVersion,
    ffmpegPath,
    ffprobePath,
    pythonRoot,
    pythonPath,
    pythonPackagesPath,
    cpythonVersion: "3.12.13+20260805",
  });
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

async function main(argv) {
  const valued = new Set(["--artifact-version", "--cache-root", "--release-media-root"]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--release-media") continue;
    if (!valued.has(argv[index]) || argv[index + 1] === undefined) {
      fail("unknown or incomplete argument", { argument: argv[index] });
    }
    index += 1;
  }
  const result = await preparePackagedRuntime({
    artifactVersion: argumentValue(argv, "--artifact-version"),
    cacheRoot: argumentValue(argv, "--cache-root"),
    releaseMedia: argv.includes("--release-media"),
    releaseMediaRoot: argumentValue(argv, "--release-media-root"),
  });
  process.stderr.write(`prepare-packaged-runtime: ${result.target}\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
