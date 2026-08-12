import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_MIGRATION_PATHS } from "./artifact-runtime-contract.mjs";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const requireFromRepository = createRequire(new URL("../package.json", import.meta.url));
const requireFromAdapter = createRequire(new URL("../packages/adapter/package.json", import.meta.url));
const requireFromCli = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const { tsImport } = requireFromCli("tsx/esm/api");

const INPUT_KEYS = [
  "schemaVersion",
  "artifactVersion",
  "platform",
  "ffmpegPath",
  "ffmpegVersion",
  "ffmpegSha256",
  "ffprobePath",
  "ffprobeVersion",
  "ffprobeSha256",
  "pythonRoot",
  "pythonPath",
  "cpythonVersion",
  "pythonSha256",
  "pythonTreeSha256",
  "pythonRuntimeTreeSha256",
  "pythonPackagesPath",
  "pythonPackagesSha256",
  "vieneuRoot",
  "vieneuWorkerSha256",
];
const PLATFORM_TAGS = new Set(["darwin-arm64", "linux-x64", "win32-x64"]);
const ARTIFACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const EXPECTED_NODE_VERSION = "24.9.0";
const EXPECTED_NODE_PTY_VERSION = "1.1.0";
const HYPERFRAMES_BROWSER_SCRIPTS = Object.freeze([
  "layout-audit.browser.js",
  "motion-sample.browser.js",
  "contrast-audit.browser.js",
]);
const EXPECTED_HYPERFRAMES_VERSION = "0.7.86";
const EXPECTED_VIENEU_VERSION = "3.2.4";
const EXPECTED_CPYTHON_VERSION = "3.12.13+20260805";
const PROCESS_START_ID = `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1_000)}`;
const ACTIVE_PUBLICATIONS = new Set();
const MOTION_PACKAGE_NAMES = ["animejs", "gsap", "lottie-web", "motion", "three"];
const COMMON_NATIVE_PACKAGES = [
  "node-pty",
  "sharp",
  "@img/colour",
  "detect-libc",
  "semver",
  "esbuild",
  "onnxruntime-node",
  "onnxruntime-common",
];
const HYPERFRAMES_EXTERNALS = [
  "sharp",
  "onnxruntime-node",
  "esbuild",
  "@hyperframes/aws-lambda/sdk",
  "@hyperframes/gcp-cloud-run/sdk",
  "@hyperframes/gcp-cloud-run/terraform",
];
const PYTHON_METADATA_PROBE = String.raw`
import importlib.metadata as metadata
import json

packages = {}
for distribution in metadata.distributions():
    raw_name = distribution.metadata.get("Name")
    if not raw_name:
        continue
    name = raw_name.lower().replace("_", "-")
    version = distribution.version.strip()
    if not version:
        raise RuntimeError(f"empty version for {name}")
    if name in packages:
        raise RuntimeError(f"duplicate package {name}")
    packages[name] = version

print(json.dumps({
    "packages": sorted(f"{name}=={version}" for name, version in packages.items()),
    "vieneu": packages.get("vieneu", ""),
}, separators=(",", ":")))
`;

function fail(message, details) {
  const error = new Error(details ? `${message}: ${JSON.stringify(details)}` : message);
  error.details = details;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected keys`, { actual, expected: wanted });
  }
}

function canonicalString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a canonical non-empty string`);
  }
  return value;
}

function absolutePath(value, label) {
  const pathname = canonicalString(value, label);
  if (!path.isAbsolute(pathname) || path.normalize(pathname) !== pathname) {
    fail(`${label} must be an absolute normalized path`, { path: pathname });
  }
  return pathname;
}

function sha256Pin(value, label) {
  const pin = canonicalString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(pin)) fail(`${label} must be an exact lowercase SHA-256 pin`);
  return pin;
}

function contained(root, candidate) {
  const relation = path.relative(root, candidate);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation));
}

export function hostPlatformTag(platform = process.platform, architecture = process.arch) {
  const tag = `${platform}-${architecture}`;
  if (!PLATFORM_TAGS.has(tag)) fail("the runtime stager does not support this host", { platform, architecture });
  return tag;
}

export function nativePackageNamesFor(platform) {
  if (!PLATFORM_TAGS.has(platform)) fail("unsupported runtime platform", { platform });
  const platformPackages = {
    "darwin-arm64": [
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
      "@esbuild/darwin-arm64",
    ],
    "linux-x64": [
      "@img/sharp-linux-x64",
      "@img/sharp-libvips-linux-x64",
      "@esbuild/linux-x64",
    ],
    "win32-x64": ["@img/sharp-win32-x64", "@esbuild/win32-x64"],
  }[platform];
  return Object.freeze([...COMMON_NATIVE_PACKAGES, ...platformPackages]);
}

export function esbuildPlatformBinaryRelative(platform) {
  if (!PLATFORM_TAGS.has(platform)) fail("unsupported runtime platform", { platform });
  return platform === "win32-x64" ? "esbuild.exe" : path.join("bin", "esbuild");
}

export function parseRuntimeInputsValue(value, expectedPlatform = hostPlatformTag()) {
  const input = object(value, "runtime staging inputs");
  exactKeys(input, INPUT_KEYS, "runtime staging inputs");
  if (input.schemaVersion !== 1) fail("runtime staging input schema version is unsupported");
  const artifactVersion = canonicalString(input.artifactVersion, "artifactVersion");
  if (
    artifactVersion.length > 128
    || !ARTIFACT_VERSION_PATTERN.test(artifactVersion)
    || artifactVersion.toLowerCase() === "current.json"
  ) fail("artifactVersion must be a portable path segment");
  const platform = canonicalString(input.platform, "platform");
  if (platform !== expectedPlatform) {
    fail("runtime inputs do not match the build host", { expected: expectedPlatform, actual: platform });
  }
  return Object.freeze({
    schemaVersion: 1,
    artifactVersion,
    platform,
    ffmpegPath: absolutePath(input.ffmpegPath, "ffmpegPath"),
    ffmpegVersion: canonicalString(input.ffmpegVersion, "ffmpegVersion"),
    ffmpegSha256: sha256Pin(input.ffmpegSha256, "ffmpegSha256"),
    ffprobePath: absolutePath(input.ffprobePath, "ffprobePath"),
    ffprobeVersion: canonicalString(input.ffprobeVersion, "ffprobeVersion"),
    ffprobeSha256: sha256Pin(input.ffprobeSha256, "ffprobeSha256"),
    pythonRoot: absolutePath(input.pythonRoot, "pythonRoot"),
    pythonPath: absolutePath(input.pythonPath, "pythonPath"),
    cpythonVersion: canonicalString(input.cpythonVersion, "cpythonVersion"),
    pythonSha256: sha256Pin(input.pythonSha256, "pythonSha256"),
    pythonTreeSha256: sha256Pin(input.pythonTreeSha256, "pythonTreeSha256"),
    pythonRuntimeTreeSha256: sha256Pin(input.pythonRuntimeTreeSha256, "pythonRuntimeTreeSha256"),
    pythonPackagesPath: absolutePath(input.pythonPackagesPath, "pythonPackagesPath"),
    pythonPackagesSha256: sha256Pin(input.pythonPackagesSha256, "pythonPackagesSha256"),
    vieneuRoot: absolutePath(input.vieneuRoot, "vieneuRoot"),
    vieneuWorkerSha256: sha256Pin(input.vieneuWorkerSha256, "vieneuWorkerSha256"),
  });
}

async function readRuntimeInputs(filename, expectedPlatform) {
  await assertRegularFile(filename, "runtime staging input file", false);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    fail("runtime staging inputs are not valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const input = parseRuntimeInputsValue(parsed, expectedPlatform);
  const pythonRoot = await assertRealDirectory(input.pythonRoot, "frozen Python root");
  const vieneuRoot = await assertRealDirectory(input.vieneuRoot, "frozen VieNeu root");
  return Object.freeze({
    ...input,
    ffmpegPath: await assertRegularFile(input.ffmpegPath, "FFmpeg input"),
    ffprobePath: await assertRegularFile(input.ffprobePath, "FFprobe input"),
    pythonRoot,
    pythonPath: await assertRegularFile(input.pythonPath, "frozen Python interpreter"),
    pythonPackagesPath: await assertRegularFile(
      input.pythonPackagesPath,
      "approved Python package evidence",
      false,
    ),
    vieneuRoot,
  });
}

/**
 * Insists on a real file, and by default on the only name pointing at it.
 *
 * The single-link rule guards what this build *publishes*: a staged file with a
 * second name can be rewritten through that other name after it was verified,
 * which is a provenance hole. It is the wrong rule for what the build *reads*.
 * Bun hardlinks packages out of its global cache on Linux, so every
 * `package.json` in `node_modules` has more than one link — and applying the
 * publish rule to inputs made the whole build unrunnable there while passing on
 * macOS, where the same installer copies instead. Callers reading installer
 * output pass `shared`.
 */
async function assertRegularFile(filename, label, executable = true, shared = false) {
  const metadata = await lstat(filename).catch(() => null);
  if (
    metadata === null
    || metadata.isSymbolicLink()
    || !metadata.isFile()
    || (!shared && metadata.nlink !== 1)
  ) fail(`${label} must be a real regular file`, { path: filename });
  if (executable && process.platform !== "win32") {
    if ((metadata.mode & 0o111) === 0) fail(`${label} must be executable`, { path: filename });
    await access(filename, constants.X_OK).catch(() => fail(`${label} must be executable`, { path: filename }));
  }
  return realpath(filename);
}

async function assertRealDirectory(directory, label) {
  const metadata = await lstat(directory).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a real directory`, { path: directory });
  }
  return realpath(directory);
}

export async function assertContainedRegularFile(root, filename, label, executable = false, shared = false) {
  const canonicalRoot = await realpath(root);
  const canonicalFile = await assertRegularFile(filename, label, executable, shared);
  if (!contained(canonicalRoot, canonicalFile)) {
    fail(`${label} escapes its source authority`, { root: canonicalRoot, path: filename, canonicalFile });
  }
  return canonicalFile;
}

function runChecked(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? {},
    shell: false,
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
  });
  if (result.error) fail(`${label} could not start`, { cause: result.error.message });
  if (result.status !== 0) {
    fail(`${label} failed`, {
      exitCode: result.status,
      stderr: result.stderr?.trim().slice(0, 500),
    });
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function privateProbeEnvironment(home, temporary) {
  const environment = {
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: process.platform === "win32" ? "" : "/usr/bin:/bin",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    USERPROFILE: home,
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot) environment.PATH = `${path.join(systemRoot, "System32")};${systemRoot}`;
  }
  return environment;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function assertFileDigest(filename, expected, label) {
  const actual = await sha256File(filename);
  if (actual !== expected) fail(`${label} does not match its approved digest`, { expected, actual });
  return actual;
}

function versionFrom(output, pattern, label) {
  const match = output.match(pattern);
  if (!match?.[1]) fail(`${label} returned an unrecognized version`, { output: output.slice(0, 200) });
  return match[1];
}

export function assertPortableDarwinDependencies(output, label) {
  const dependencies = output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u, 1)[0])
    .filter(Boolean);
  const forbidden = dependencies.filter((dependency) => !dependency.startsWith("/usr/lib/")
    && !dependency.startsWith("/System/Library/"));
  if (forbidden.length > 0) {
    fail(`${label} links to non-portable Darwin libraries`, { forbidden });
  }
  return dependencies;
}

export function assertNoDarwinRuntimeSearchPaths(output, label) {
  const lines = output.split(/\r?\n/u);
  const runtimePaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") continue;
    for (let detail = index + 1; detail < Math.min(lines.length, index + 6); detail += 1) {
      const match = lines[detail]?.trim().match(/^path\s+(\S+)\s+\(offset/u);
      if (match?.[1]) {
        runtimePaths.push(match[1]);
        break;
      }
    }
  }
  if (runtimePaths.length > 0) {
    fail(`${label} declares runtime library search paths but no dylib closure is staged`, { runtimePaths });
  }
  return runtimePaths;
}

async function inspectDarwinBinary(filename, label, environment) {
  if (process.platform !== "darwin") return;
  const dependencies = runChecked(
    "/usr/bin/otool",
    ["-L", filename],
    `${label} dependency inspection`,
    { env: environment },
  );
  assertPortableDarwinDependencies(dependencies.stdout, label);
  const loadCommands = runChecked(
    "/usr/bin/otool",
    ["-l", filename],
    `${label} load-command inspection`,
    { env: environment },
  );
  assertNoDarwinRuntimeSearchPaths(loadCommands.stdout, label);
}

function parsePythonMetadata(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("the staged Python metadata probe returned invalid JSON");
  }
  const payload = object(parsed, "Python metadata probe");
  exactKeys(payload, ["packages", "vieneu"], "Python metadata probe");
  if (!Array.isArray(payload.packages) || payload.packages.some((pin) => typeof pin !== "string")) {
    fail("Python metadata probe packages must be strings");
  }
  return {
    packages: [...payload.packages],
    vieneu: canonicalString(payload.vieneu, "VieNeu version"),
  };
}

export function assertExactPythonPackages(actualPackages, expectedPackages) {
  const actual = [...actualPackages];
  const expected = [...expectedPackages];
  if (actual.some((pin) => !/^[a-z0-9][a-z0-9.-]*==[^=\s]+$/u.test(pin))) {
    fail("staged Python package pins must use normalized exact name==version values");
  }
  if (actual.some((pin, index) => index > 0 && pin <= actual[index - 1])) {
    fail("staged Python package pins must be unique and sorted");
  }
  if (actual.some((pin) => pin.toLowerCase().startsWith("pip=="))) {
    fail("pip must not be present in the staged Python runtime");
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    fail("staged Python package set does not match measured release evidence", {
      missing: expected.filter((pin) => !actualSet.has(pin)),
      unexpected: actual.filter((pin) => !expectedSet.has(pin)),
    });
  }
}

async function probeStagedRuntime({ ffmpegPath, ffprobePath, pythonPath, esbuildPath }, environment) {
  const ffmpegOutput = runChecked(
    ffmpegPath,
    ["-version"],
    "staged FFmpeg probe",
    { env: environment },
  ).stdout;
  const ffprobeOutput = runChecked(
    ffprobePath,
    ["-version"],
    "staged FFprobe probe",
    { env: environment },
  ).stdout;
  const ffmpeg = versionFrom(ffmpegOutput, /^ffmpeg version\s+([^\s]+)/u, "FFmpeg");
  const ffprobe = versionFrom(ffprobeOutput, /^ffprobe version\s+([^\s]+)/u, "FFprobe");
  if (ffmpeg !== ffprobe) fail("FFmpeg and FFprobe versions do not match", { ffmpeg, ffprobe });

  const esbuild = versionFrom(
    runChecked(esbuildPath, ["--version"], "staged esbuild probe", { env: environment }).stdout,
    /^(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/u,
    "esbuild",
  );
  const cpython = versionFrom(
    runChecked(pythonPath, ["--version"], "staged Python version probe", { env: environment }).stdout,
    /^Python\s+(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/u,
    "Python",
  );
  const pythonEnvironment = {
    ...environment,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
  };
  const metadata = parsePythonMetadata(runChecked(
    pythonPath,
    ["-B", "-I", "-c", PYTHON_METADATA_PROBE],
    "staged Python metadata probe",
    { env: pythonEnvironment },
  ).stdout);
  return {
    ffmpeg,
    ffprobe,
    esbuild,
    cpython,
    vieneu: metadata.vieneu,
    pythonPackages: metadata.packages,
  };
}

async function readPackageManifest(packageRoot, expectedName) {
  const filename = path.join(packageRoot, "package.json");
  const canonical = await assertContainedRegularFile(
    packageRoot,
    filename,
    `${expectedName} package manifest`,
    false,
    // Installer output: Bun hardlinks it out of its global cache on Linux, and
    // this manifest is read for its name and version, never published.
    true,
  );
  const manifest = object(JSON.parse(await readFile(canonical, "utf8")), `${expectedName} package manifest`);
  if (manifest.name !== expectedName) fail("resolved package has the wrong name", { expectedName, actual: manifest.name });
  return {
    path: canonical,
    version: canonicalString(manifest.version, `${expectedName} version`),
  };
}

/** Resolves package roots without deep specifiers, which several packages block through `exports`. */
export async function resolvePackageDirectory(packageName, resolver) {
  // Ask Node first. It runs the real resolution algorithm, which follows the
  // package store layout a scan of `resolve.paths()` can miss — that scan reads
  // directory names, and a store keyed by content hash puts the sibling
  // somewhere the plain list never mentions. Not every package exposes its
  // manifest through `exports` (sharp does not), so the scan stays as the
  // fallback rather than being replaced.
  try {
    const manifest = resolver.resolve(`${packageName}/package.json`);
    const canonical = await realpath(path.dirname(manifest));
    await readPackageManifest(canonical, packageName);
    return canonical;
  } catch {
    // Either the package hides its manifest or it is genuinely absent; the scan
    // below tells those two apart.
  }

  const searchPaths = resolver.resolve.paths(packageName) ?? [];
  for (const searchRoot of searchPaths) {
    const candidate = path.join(searchRoot, ...packageName.split("/"));
    if (!existsSync(candidate)) continue;
    const canonical = await realpath(candidate);
    try {
      await readPackageManifest(canonical, packageName);
      return canonical;
    } catch {
      // Another package store entry may exist later in the anchored search list.
    }
  }
  // Last resort: the repository's own resolver. Bun keys its store directories
  // by the resolved dependency set, and that set is platform-specific, so the
  // sibling a search from HyperFrames finds on one runner is not always where
  // another runner puts it. The repository pins these packages directly, so the
  // copy it resolves is the same instance — and `readPackageManifest` still has
  // to agree it is the right package before it ships.
  try {
    const manifest = requireFromRepository.resolve(`${packageName}/package.json`);
    const canonical = await realpath(path.dirname(manifest));
    await readPackageManifest(canonical, packageName);
    return canonical;
  } catch {
    // Fall through to the failure below, which names the package.
  }

  for (const searchRoot of requireFromRepository.resolve.paths(packageName) ?? []) {
    const candidate = path.join(searchRoot, ...packageName.split("/"));
    if (!existsSync(candidate)) continue;
    const canonical = await realpath(candidate);
    try {
      await readPackageManifest(canonical, packageName);
      return canonical;
    } catch {
      // Another store entry may match later in the list.
    }
  }

  // Says what it looked at, not just that it failed. This resolution depends on
  // how the package manager laid out the store, which differs per platform, and
  // a bare "not installed" turns every platform difference into another guess.
  const looked = [
    ...(resolver.resolve.paths(packageName) ?? []),
    ...(requireFromRepository.resolve.paths(packageName) ?? []),
  ].slice(0, 8);
  const present = looked.filter((searchRoot) => existsSync(path.join(searchRoot, ...packageName.split("/"))));
  fail(`required package ${packageName} is not installed for the HyperFrames runtime`, {
    searched: looked,
    present,
  });
}

async function defaultHyperframesRoot() {
  const manifest = requireFromRepository.resolve("hyperframes/package.json");
  return realpath(path.dirname(manifest));
}

export async function resolveNativePackageRoots(hyperframesRoot, platform) {
  const hyperframesResolver = createRequire(path.join(hyperframesRoot, "package.json"));
  const direct = new Map(await Promise.all([
    ["sharp", hyperframesResolver],
    ["esbuild", hyperframesResolver],
    ["onnxruntime-node", hyperframesResolver],
    // node-pty is owned by the adapter rather than HyperFrames. Resolving it
    // through HyperFrames can select no package at all in Bun's isolated store.
    ["node-pty", requireFromAdapter],
  ].map(async ([packageName, resolver]) => [
    packageName,
    await resolvePackageDirectory(packageName, resolver),
  ])));
  const sharpResolver = createRequire(path.join(direct.get("sharp"), "package.json"));
  const esbuildResolver = createRequire(path.join(direct.get("esbuild"), "package.json"));
  const onnxResolver = createRequire(path.join(direct.get("onnxruntime-node"), "package.json"));
  const owners = new Map([
    ["sharp", hyperframesResolver],
    ["esbuild", hyperframesResolver],
    ["onnxruntime-node", hyperframesResolver],
    ["node-pty", requireFromAdapter],
    ["onnxruntime-common", onnxResolver],
    ["@img/colour", sharpResolver],
    ["detect-libc", sharpResolver],
    ["semver", sharpResolver],
  ]);
  for (const packageName of nativePackageNamesFor(platform)) {
    if (packageName.startsWith("@img/")) owners.set(packageName, sharpResolver);
    if (packageName.startsWith("@esbuild/")) owners.set(packageName, esbuildResolver);
  }
  return new Map(await Promise.all(nativePackageNamesFor(platform).map(async (packageName) => {
    const resolver = owners.get(packageName);
    if (!resolver) fail(`native package ${packageName} has no owning dependency authority`);
    return [packageName, direct.get(packageName) ?? await resolvePackageDirectory(packageName, resolver)];
  })));
}

async function defaultMotionLibraries() {
  const imported = await tsImport("../packages/contracts/src/motion-libraries.ts", import.meta.url);
  return imported.MOTION_LIBRARIES;
}

async function defaultMotionPackageRoots(libraries) {
  return new Map(await Promise.all(libraries.map(async ({ packageName }) => [
    packageName,
    await resolvePackageDirectory(packageName, requireFromAdapter),
  ])));
}

function packageDestination(nodeModulesRoot, packageName) {
  return path.join(nodeModulesRoot, ...packageName.split("/"));
}

/**
 * Materializes only symlinks whose canonical target remains inside the copied source tree.
 *
 * `shared` says the source is installer output rather than something this build
 * produced. Bun hardlinks packages out of its global cache on Linux, so every
 * file under `node_modules` has a second name — refusing that made the whole
 * stage unrunnable there while passing on macOS, where the same installer
 * copies. The refusal still applies to trees this build owns, where a second
 * name means a verified file can be rewritten behind the verification.
 */
export async function copyContainedTree(source, destination, shared = false) {
  const canonicalRoot = await assertRealDirectory(source, "copy source root");

  const materializeFile = async (sourceFile, destinationFile, metadata) => {
    if (!shared && metadata.nlink !== 1) {
      fail("copy source contains a hard-linked file", { path: sourceFile, links: metadata.nlink });
    }
    await mkdir(path.dirname(destinationFile), { recursive: true });
    await copyFile(sourceFile, destinationFile);
    await chmod(destinationFile, metadata.mode & 0o777);
  };

  const materialize = async (sourcePath, destinationPath, activeDirectories) => {
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      const target = await realpath(sourcePath).catch(() => null);
      if (target === null || !contained(canonicalRoot, target)) {
        fail("copy source symlink escapes its source authority", {
          root: canonicalRoot,
          path: sourcePath,
          target,
        });
      }
      const targetMetadata = await lstat(target);
      if (targetMetadata.isFile()) {
        await materializeFile(target, destinationPath, targetMetadata);
        return;
      }
      if (targetMetadata.isDirectory()) {
        await materializeDirectory(target, destinationPath, activeDirectories);
        return;
      }
      fail("copy source symlink targets a special file", { path: sourcePath, target });
    }
    if (metadata.isFile()) {
      await materializeFile(sourcePath, destinationPath, metadata);
      return;
    }
    if (metadata.isDirectory()) {
      const canonical = await realpath(sourcePath);
      if (!contained(canonicalRoot, canonical)) {
        fail("copy source directory escapes its source authority", { path: sourcePath, canonical });
      }
      await materializeDirectory(canonical, destinationPath, activeDirectories);
      return;
    }
    fail("copy source contains a special file", { path: sourcePath });
  };

  const materializeDirectory = async (sourceDirectory, destinationDirectory, activeDirectories) => {
    const canonicalDirectory = await realpath(sourceDirectory);
    if (!contained(canonicalRoot, canonicalDirectory)) {
      fail("copy source directory escapes its source authority", {
        root: canonicalRoot,
        path: sourceDirectory,
        canonicalDirectory,
      });
    }
    if (activeDirectories.has(canonicalDirectory)) {
      fail("copy source contains a directory symlink cycle", { path: sourceDirectory });
    }
    activeDirectories.add(canonicalDirectory);
    try {
      const metadata = await lstat(canonicalDirectory);
      await mkdir(destinationDirectory, { recursive: true, mode: metadata.mode & 0o777 });
      const entries = await readdir(canonicalDirectory);
      entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      for (const entry of entries) {
        await materialize(
          path.join(canonicalDirectory, entry),
          path.join(destinationDirectory, entry),
          activeDirectories,
        );
      }
    } finally {
      activeDirectories.delete(canonicalDirectory);
    }
  };

  await materializeDirectory(canonicalRoot, destination, new Set());
}

/** Hashes the exact regular tree projection, materializing contained symlinks in the digest contract. */
export async function materializedTreeSha256(source) {
  const canonicalRoot = await assertRealDirectory(source, "tree digest source root");
  const manifest = [];
  const visit = async (sourcePath, relative, activeDirectories) => {
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      const target = await realpath(sourcePath).catch(() => null);
      if (target === null || !contained(canonicalRoot, target)) {
        fail("tree digest symlink escapes its source authority", { path: sourcePath, target });
      }
      const targetMetadata = await lstat(target);
      if (targetMetadata.isFile()) {
        if (targetMetadata.nlink !== 1) {
          fail("tree digest source contains a hard-linked file", { path: sourcePath, target });
        }
        manifest.push([
          "file",
          relative.split(path.sep).join("/"),
          targetMetadata.mode & 0o777,
          targetMetadata.size,
          await sha256File(target),
        ]);
        return;
      }
      if (targetMetadata.isDirectory()) {
        await visitDirectory(target, relative, activeDirectories);
        return;
      }
      fail("tree digest symlink targets a special file", { path: sourcePath, target });
    }
    if (metadata.isFile()) {
      if (metadata.nlink !== 1) fail("tree digest source contains a hard-linked file", { path: sourcePath });
      manifest.push([
        "file",
        relative.split(path.sep).join("/"),
        metadata.mode & 0o777,
        metadata.size,
        await sha256File(sourcePath),
      ]);
      return;
    }
    if (metadata.isDirectory()) {
      await visitDirectory(await realpath(sourcePath), relative, activeDirectories);
      return;
    }
    fail("tree digest source contains a special file", { path: sourcePath });
  };
  const visitDirectory = async (directory, relative, activeDirectories) => {
    const canonicalDirectory = await realpath(directory);
    if (!contained(canonicalRoot, canonicalDirectory)) {
      fail("tree digest directory escapes its source authority", { path: directory, canonicalDirectory });
    }
    if (activeDirectories.has(canonicalDirectory)) {
      fail("tree digest source contains a directory symlink cycle", { path: directory });
    }
    const metadata = await lstat(canonicalDirectory);
    manifest.push(["directory", relative.split(path.sep).join("/"), metadata.mode & 0o777]);
    activeDirectories.add(canonicalDirectory);
    try {
      const entries = await readdir(canonicalDirectory);
      entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      for (const entry of entries) {
        await visit(
          path.join(canonicalDirectory, entry),
          relative ? path.join(relative, entry) : entry,
          activeDirectories,
        );
      }
    } finally {
      activeDirectories.delete(canonicalDirectory);
    }
  };
  await visitDirectory(canonicalRoot, "", new Set());
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

const NON_RUNTIME_DIRECTORIES = new Set([
  ".github",
  "build",
  "docs",
  "examples",
  "install",
  "script",
  "scripts",
  "src",
  "test",
  "tests",
]);

async function sanitizeJavaScriptFile(filename) {
  const source = await readFile(filename, "utf8");
  const sanitized = source.replaceAll("sourceMappingURL=", "sourceMappingURL\\x3d");
  if (sanitized !== source) await writeFile(filename, sanitized, "utf8");
}

function runtimePackageFile(relative, metadata, packageName) {
  const basename = path.basename(relative);
  if (basename === "package.json") return true;
  if (/^(?:licen[cs]e|notice|copying|third[-_]party)(?:[._-].*)?$/iu.test(basename)) return true;
  if (/^readme(?:[._-].*)?$/iu.test(basename)) return true;
  if (/\.(?:cjs|mjs|js|json|node|wasm|dylib|dll|exe)$/iu.test(basename)) return true;
  if (/\.so(?:\.\d+)*$/iu.test(basename)) return true;
  if (packageName === "node-pty" && basename === "spawn-helper" && (metadata.mode & 0o111) !== 0) return true;
  return !basename.includes(".") && (metadata.mode & 0o111) !== 0 && relative.split(path.sep).includes("bin");
}

/** Removes install/build/source material while preserving package manifests, licenses, JS and native payloads. */
export async function pruneRuntimePackageTree(packageRoot, packageName, platform) {
  const [hostPlatform, hostArchitecture] = platform.split("-");
  if (packageName === "onnxruntime-node") {
    const nativeRoot = path.join(packageRoot, "bin", "napi-v3");
    for (const platformEntry of await readdir(nativeRoot, { withFileTypes: true }).catch(() => [])) {
      const platformPath = path.join(nativeRoot, platformEntry.name);
      if (platformEntry.name !== hostPlatform) {
        await rm(platformPath, { recursive: true, force: true });
        continue;
      }
      for (const architectureEntry of await readdir(platformPath, { withFileTypes: true })) {
        if (architectureEntry.name !== hostArchitecture) {
          await rm(path.join(platformPath, architectureEntry.name), { recursive: true, force: true });
        }
      }
    }
  }
  if (packageName === "node-pty") {
    const prebuildsRoot = path.join(packageRoot, "prebuilds");
    const hostPrebuild = `${hostPlatform}-${hostArchitecture}`;
    for (const entry of await readdir(prebuildsRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.name !== hostPrebuild) {
        await rm(path.join(prebuildsRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
  const visit = async (directory, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (NON_RUNTIME_DIRECTORIES.has(entry.name.toLowerCase())) {
          await rm(absolute, { recursive: true, force: true });
          continue;
        }
        await visit(absolute, relative);
        if ((await readdir(absolute)).length === 0) await rm(absolute, { recursive: true });
        continue;
      }
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.nlink !== 1) {
        fail("staged native package contains a special or hard-linked file", { path: absolute });
      }
      if (!runtimePackageFile(relative, metadata, packageName)) {
        await rm(absolute);
      } else {
        if (/\.(?:cjs|mjs|js)$/iu.test(entry.name)) await sanitizeJavaScriptFile(absolute);
        await chmod(absolute, (metadata.mode & 0o111) === 0 ? 0o644 : 0o755);
      }
    }
  };
  await visit(packageRoot);
  await readPackageManifest(packageRoot, packageName);
}

async function copyNativeClosure(packageRoots, packageNames, platform, ...archiveRoots) {
  for (const packageName of packageNames) {
    const source = packageRoots.get(packageName);
    if (!source) fail(`native package root is missing for ${packageName}`);
    await readPackageManifest(source, packageName);
    for (const archiveRoot of archiveRoots) {
      const destination = packageDestination(path.join(archiveRoot, "node_modules"), packageName);
      await mkdir(path.dirname(destination), { recursive: true });
      // Installer output: hardlinked out of Bun's global cache on Linux.
      await copyContainedTree(source, destination, true);
      await pruneRuntimePackageTree(destination, packageName, platform);
    }
  }
}

export async function stageNativeClosure(packageRoots, platform, ...archiveRoots) {
  if (archiveRoots.length === 0) fail("native closure staging requires at least one archive root");
  await copyNativeClosure(
    packageRoots,
    nativePackageNamesFor(platform),
    platform,
    ...archiveRoots,
  );
  const probeRoot = path.join(path.dirname(archiveRoots[0]), `.native-probe-${randomUUID()}`);
  const home = path.join(probeRoot, "home");
  const temporary = path.join(probeRoot, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(temporary, { recursive: true });
  try {
    const environment = privateProbeEnvironment(home, temporary);
    for (const archiveRoot of archiveRoots) probeStagedNativeClosure(archiveRoot, environment);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export function probeStagedNativeClosure(archiveRoot, environment) {
  const probe = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createRequire } = Module;
const builtins = new Set(Module.builtinModules.flatMap((name) => [name, "node:" + name]));
const archiveRoot = fs.realpathSync(process.argv[1]);
const nodeModulesRoot = fs.realpathSync(path.join(archiveRoot, "node_modules"));
const contained = (root, candidate) => {
  const relation = path.relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(".." + path.sep) && !path.isAbsolute(relation));
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  const resolved = originalResolve.call(this, request, parent, isMain, options);
  if (typeof resolved === "string" && !builtins.has(resolved)) {
    const canonical = fs.realpathSync(resolved);
    if (!contained(nodeModulesRoot, canonical)) {
      throw new Error("native dependency escaped staged closure: " + request + " -> " + canonical);
    }
  }
  return resolved;
};
const requireFromStage = createRequire(path.join(process.argv[1], "native-closure-probe.cjs"));
for (const packageName of process.argv.slice(2)) requireFromStage(packageName);
const nodePty = requireFromStage("node-pty");
const terminal = nodePty.spawn(process.execPath, ["-e", "process.stdout.write('VIDCOM_PTY_PROBE')"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: archiveRoot,
  env: process.env,
});
let ptyOutput = "";
terminal.onData((data) => { ptyOutput += data; });
terminal.onExit(({ exitCode }) => {
  if (exitCode !== 0 || !ptyOutput.includes("VIDCOM_PTY_PROBE")) {
    throw new Error("node-pty staged native process probe failed");
  }
});
`;
  runChecked(
    process.execPath,
    ["-e", probe, archiveRoot, "sharp", "esbuild", "onnxruntime-node", "node-pty"],
    "staged native dependency closure probe",
    { env: environment },
  );
}

function pythonBuildTool(relativePath, directory) {
  const segments = relativePath.split(path.sep).map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? "";
  if (!directory && segments.length === 2 && segments[0] === "bin" && basename !== "python3") {
    return true;
  }
  if (!directory && segments.length === 2 && segments[0] === "scripts") return true;
  if (!directory && basename === "record" && segments.some((segment) => segment.endsWith(".dist-info"))) {
    return true;
  }
  if (directory && (basename === "__pycache__" || basename === "ensurepip")) return true;
  if (directory && segments.includes("site-packages") && (
    basename === "pip"
    || /^pip-.*\.(?:dist|egg)-info$/u.test(basename)
  )) return true;
  if (!directory && (/\.py[co]$/u.test(basename) || /^pip(?:\d+(?:\.\d+)*)?(?:\.exe|-script\.py)?$/u.test(basename))) {
    return true;
  }
  return false;
}

export async function prunePythonBuildTools(pythonRoot) {
  const visit = async (directory, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeDirectory, entry.name);
      if (pythonBuildTool(relative, entry.isDirectory())) {
        await rm(absolute, { recursive: entry.isDirectory(), force: true });
      } else if (entry.isDirectory()) {
        await visit(absolute, relative);
      }
    }
  };
  await visit(pythonRoot);
}

/** Copies only Drizzle's executable migration SQL; snapshots are build metadata, not runtime assets. */
export async function stageDrizzleMigrations(sourceRoot, destinationRoot) {
  const canonicalRoot = await assertRealDirectory(sourceRoot, "Drizzle migration root");
  const migrations = [];
  for (const runtimePath of PRODUCT_MIGRATION_PATHS) {
    const relative = runtimePath.replace(/^drizzle\//u, "");
    const source = path.join(canonicalRoot, ...relative.split("/"));
    const canonicalSource = await assertContainedRegularFile(
      canonicalRoot,
      source,
      `Drizzle migration ${relative}`,
    );
    const destination = path.join(destinationRoot, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(canonicalSource, destination);
    migrations.push(runtimePath);
  }
  return migrations;
}

async function stageMotionLibraries(destinationRoot, libraries, packageRoots) {
  const versions = {};
  for (const library of libraries) {
    const sourceRoot = packageRoots.get(library.packageName);
    if (!sourceRoot) fail(`motion package root is missing for ${library.packageName}`);
    const manifest = await readPackageManifest(sourceRoot, library.packageName);
    if (manifest.version !== library.version) {
      fail("motion package version does not match the product catalogue", {
        package: library.packageName,
        expected: library.version,
        actual: manifest.version,
      });
    }
    const packageRoot = path.join(destinationRoot, library.packageName);
    await mkdir(packageRoot, { recursive: true });
    await copyFile(manifest.path, path.join(packageRoot, "package.json"));
    for (const file of library.files) {
      const source = path.resolve(sourceRoot, file.packagePath);
      if (!contained(sourceRoot, source)) fail("motion package path escapes its package", { path: file.packagePath });
      const canonicalSource = await assertContainedRegularFile(
        sourceRoot,
        source,
        `${library.packageName} motion asset`,
        false,
        true,
      );
      const destination = path.join(packageRoot, ...file.packagePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(canonicalSource, destination);
      if (/\.(?:cjs|mjs|js)$/iu.test(destination)) await sanitizeJavaScriptFile(destination);
    }
    versions[library.packageName] = manifest.version;
  }
  exactKeys(versions, MOTION_PACKAGE_NAMES, "staged motion package versions");
  return versions;
}

async function bundleHyperframesCli(entry, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  const result = spawnSync("bun", [
    "build",
    entry,
    "--target=node",
    "--format=esm",
    `--outfile=${outfile}`,
    "--sourcemap=none",
    ...HYPERFRAMES_EXTERNALS.flatMap((name) => ["--external", name]),
  ], {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
  if (result.error) fail("HyperFrames bundler could not start", { cause: result.error.message });
  if (result.status !== 0) fail("HyperFrames CLI bundling failed", { exitCode: result.status });
}

async function stageHyperframes({ root, sourceRoot, libraries, motionPackageRoots, bundle }) {
  const packageManifest = await readPackageManifest(sourceRoot, "hyperframes");
  if (packageManifest.version !== EXPECTED_HYPERFRAMES_VERSION) {
    fail("HyperFrames version does not match the approved artifact", {
      expected: EXPECTED_HYPERFRAMES_VERSION,
      actual: packageManifest.version,
    });
  }
  await mkdir(path.join(root, "bin"), { recursive: true });
  await copyFile(packageManifest.path, path.join(root, "package.json"));
  const cliEntry = await assertContainedRegularFile(
    sourceRoot,
    path.join(sourceRoot, "bin", "hyperframes.mjs"),
    "HyperFrames CLI entry",
    false,
    true,
  );
  await bundle(
    cliEntry,
    path.join(root, "bin", "hyperframes.mjs"),
  );
  await sanitizeJavaScriptFile(path.join(root, "bin", "hyperframes.mjs"));

  const browserScriptRoot = path.join(root, "bin", "commands");
  await mkdir(browserScriptRoot, { recursive: true });
  for (const name of HYPERFRAMES_BROWSER_SCRIPTS) {
    const source = await assertContainedRegularFile(
      sourceRoot,
      path.join(sourceRoot, "dist", "commands", name),
      `HyperFrames ${name}`,
      false,
      true,
    );
    const destination = path.join(browserScriptRoot, name);
    await copyFile(source, destination);
    await sanitizeJavaScriptFile(destination);
  }

  const runtimeManifestSource = path.join(sourceRoot, "dist", "hyperframe.manifest.json");
  const runtimeSource = path.join(sourceRoot, "dist", "hyperframe.runtime.iife.js");
  const canonicalRuntimeManifest = await assertContainedRegularFile(
    sourceRoot,
    runtimeManifestSource,
    "HyperFrames runtime manifest",
    false,
    true,
  );
  const canonicalRuntime = await assertContainedRegularFile(
    sourceRoot,
    runtimeSource,
    "HyperFrames runtime IIFE",
    false,
    true,
  );
  const runtimeManifest = object(
    JSON.parse(await readFile(canonicalRuntimeManifest, "utf8")),
    "HyperFrames runtime manifest",
  );
  const runtimeDigest = createHash("sha256").update(await readFile(canonicalRuntime)).digest("hex");
  if (runtimeManifest.sha256 !== runtimeDigest) {
    fail("HyperFrames runtime IIFE does not match its manifest", {
      expected: runtimeManifest.sha256,
      actual: runtimeDigest,
    });
  }
  const stagedRuntime = path.join(root, "bin", "hyperframe.runtime.iife.js");
  await copyFile(canonicalRuntime, stagedRuntime);
  await sanitizeJavaScriptFile(stagedRuntime);
  runtimeManifest.sha256 = createHash("sha256").update(await readFile(stagedRuntime)).digest("hex");
  await writeFile(
    path.join(root, "bin", "hyperframe.manifest.json"),
    `${JSON.stringify(runtimeManifest)}\n`,
    "utf8",
  );
  const motion = await stageMotionLibraries(
    path.join(root, "motion-libraries"),
    libraries,
    motionPackageRoots,
  );
  return { version: packageManifest.version, motion };
}

async function walkRegularTree(root) {
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) fail("staged runtime contains a symlink", { path: target });
      if (metadata.isDirectory()) await visit(target);
      else if (!metadata.isFile() || metadata.nlink !== 1) {
        fail("staged runtime contains a special or hard-linked file", { path: target });
      }
    }
  };
  await visit(root);
}

async function optionalLstat(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function ownershipPathname(filename, platform) {
  const normalized = platform === "darwin-arm64" ? filename.normalize("NFC") : filename;
  return platform === "linux-x64" ? normalized : normalized.toLowerCase();
}

function overlappingPaths(left, right, platform) {
  const ownedLeft = ownershipPathname(left, platform);
  const ownedRight = ownershipPathname(right, platform);
  return contained(ownedLeft, ownedRight) || contained(ownedRight, ownedLeft);
}

async function inspectWriteAuthority(target, label) {
  const missing = [];
  let existing = target;
  let metadata = await optionalLstat(existing);
  while (metadata === null) {
    const parent = path.dirname(existing);
    if (parent === existing) fail(`${label} has no existing filesystem authority`, { path: target });
    missing.unshift(path.basename(existing));
    existing = parent;
    metadata = await optionalLstat(existing);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} parent chain must contain only real directories`, { path: existing });
  }
  const canonicalExisting = await realpath(existing);
  const canonicalTarget = path.join(canonicalExisting, ...missing);
  if (canonicalTarget !== target) {
    fail(`${label} parent changed authority`, { path: target, canonical: canonicalTarget });
  }
  const targetMetadata = await optionalLstat(target);
  if (targetMetadata !== null && (targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory())) {
    fail(`${label} must be a real directory`, { path: target });
  }
  return Object.freeze({ target, parent: path.dirname(target), label });
}

async function prepareWriteAuthority(authority) {
  await mkdir(authority.parent, { recursive: true, mode: 0o700 });
  const inspected = await inspectWriteAuthority(authority.target, authority.label);
  if (inspected.target !== authority.target) {
    fail(`${authority.label} changed authority while preparing it`, {
      expected: authority.target,
      actual: inspected.target,
    });
  }
}

function transactionPaths(destination) {
  return {
    backup: `${destination}.previous`,
    journal: `${destination}.publish.json`,
  };
}

async function assertRealTransactionDirectory(filename, label) {
  const metadata = await optionalLstat(filename);
  if (metadata !== null && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
    fail(`${label} must be a real directory`, { path: filename });
  }
  return metadata;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

async function runtimeGenerationDigest(root) {
  return materializedTreeSha256(root);
}

async function assertGenerationDigest(root, expected, label) {
  const actual = await runtimeGenerationDigest(root);
  if (actual !== expected) fail(`${label} does not match its publish journal`, { expected, actual });
}

/** Recovers the only two interrupted directory-switch states without exposing mixed config/tree generations. */
export async function recoverRuntimeGeneration(destination, options = {}) {
  if (ACTIVE_PUBLICATIONS.has(destination) && !options.allowActive) {
    fail("runtime staging output already has an active in-process publication", { destination });
  }
  const authority = await inspectWriteAuthority(destination, "runtime staging output");
  const { backup, journal } = transactionPaths(authority.target);
  const journalMetadata = await optionalLstat(journal);
  if (journalMetadata === null) {
    if (await optionalLstat(backup) !== null) {
      fail("runtime staging has an orphaned backup without a publish journal", { backup });
    }
    return;
  }
  if (journalMetadata.isSymbolicLink() || !journalMetadata.isFile() || journalMetadata.nlink !== 1) {
    fail("runtime staging publish journal must be a single-link regular file", { path: journal });
  }
  let payload;
  try {
    payload = object(JSON.parse(await readFile(journal, "utf8")), "runtime staging publish journal");
  } catch (error) {
    fail("runtime staging publish journal is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  exactKeys(
    payload,
    [
      "schemaVersion",
      "transactionId",
      "destination",
      "backup",
      "previousSha256",
      "nextSha256",
      "ownerPid",
      "ownerStartId",
    ],
    "runtime staging publish journal",
  );
  if (
    payload.schemaVersion !== 1
    || !/^[0-9a-f-]{36}$/u.test(payload.transactionId)
    || payload.destination !== authority.target
    || payload.backup !== backup
    || !/^sha256:[0-9a-f]{64}$/u.test(payload.previousSha256)
    || !/^sha256:[0-9a-f]{64}$/u.test(payload.nextSha256)
    || !Number.isSafeInteger(payload.ownerPid)
    || payload.ownerPid <= 0
    || typeof payload.ownerStartId !== "string"
    || payload.ownerStartId.length === 0
  ) fail("runtime staging publish journal does not match its output authority");
  if (payload.ownerPid === process.pid && payload.ownerStartId === PROCESS_START_ID) {
    fail("runtime staging publish journal belongs to this active process", {
      transactionId: payload.transactionId,
    });
  }
  if (payload.ownerPid !== process.pid && processIsAlive(payload.ownerPid)) {
    fail("another runtime staging publish is still active", { ownerPid: payload.ownerPid });
  }
  const destinationMetadata = await assertRealTransactionDirectory(authority.target, "runtime staging output");
  const backupMetadata = await assertRealTransactionDirectory(backup, "runtime staging backup");
  if (destinationMetadata === null && backupMetadata !== null) {
    await assertGenerationDigest(backup, payload.previousSha256, "runtime staging backup");
    await rename(backup, authority.target);
  } else if (destinationMetadata !== null && backupMetadata !== null) {
    await assertGenerationDigest(authority.target, payload.nextSha256, "published runtime generation");
    await assertGenerationDigest(backup, payload.previousSha256, "runtime staging backup");
    await rm(backup, { recursive: true });
  } else if (destinationMetadata !== null) {
    const actual = await runtimeGenerationDigest(authority.target);
    if (actual !== payload.previousSha256 && actual !== payload.nextSha256) {
      fail("runtime staging output does not match either journal generation", {
        previous: payload.previousSha256,
        next: payload.nextSha256,
        actual,
      });
    }
  } else {
    fail("runtime staging publish journal has lost both generations", { destination, backup });
  }
  await rm(journal);
}

/** Publishes a complete tree/config/pins generation, with a journal for process-death recovery. */
export async function commitRuntimeGeneration(temporary, destination, hooks = {}) {
  if (ACTIVE_PUBLICATIONS.has(destination)) {
    fail("runtime staging output already has an active in-process publication", { destination });
  }
  ACTIVE_PUBLICATIONS.add(destination);
  try {
  const authority = await inspectWriteAuthority(destination, "runtime staging output");
  await prepareWriteAuthority(authority);
  await recoverRuntimeGeneration(authority.target, { allowActive: true });
  const { backup, journal } = transactionPaths(authority.target);
  if (await optionalLstat(backup) !== null || await optionalLstat(journal) !== null) {
    fail("runtime staging transaction paths are already occupied", { backup, journal });
  }
  const destinationMetadata = await optionalLstat(authority.target);
  const nextSha256 = await runtimeGenerationDigest(temporary);
  if (destinationMetadata === null) {
    await hooks.beforeCommit?.();
    await rename(temporary, authority.target);
    await hooks.afterDestinationRename?.();
    return;
  }
  const previousSha256 = await runtimeGenerationDigest(authority.target);
  await writeFile(journal, `${JSON.stringify({
    schemaVersion: 1,
    transactionId: randomUUID(),
    destination: authority.target,
    backup,
    previousSha256,
    nextSha256,
    ownerPid: process.pid,
    ownerStartId: PROCESS_START_ID,
  })}\n`, { flag: "wx", mode: 0o600 });
  let destinationReplaced = false;
  try {
    await hooks.beforeCommit?.();
    await rename(authority.target, backup);
    await assertGenerationDigest(backup, previousSha256, "runtime staging backup");
    await hooks.afterPreviousRename?.();
    await rename(temporary, authority.target);
    destinationReplaced = true;
    await assertGenerationDigest(authority.target, nextSha256, "published runtime generation");
    await hooks.afterDestinationRename?.();
    await rm(backup, { recursive: true });
    await rm(journal);
  } catch (error) {
    if (destinationReplaced && await optionalLstat(authority.target) !== null) {
      await rm(authority.target, { recursive: true });
    }
    if (await optionalLstat(backup) !== null && await optionalLstat(authority.target) === null) {
      await rename(backup, authority.target);
    }
    await rm(journal, { force: true });
    throw error;
  }
  } finally {
    ACTIVE_PUBLICATIONS.delete(destination);
  }
}

export async function assertSafeBuildPaths(destinations, sources, platform) {
  for (const [label, value] of Object.entries(destinations)) absolutePath(value, label);
  const expectedConfig = path.join(destinations.outputRoot, ".build", "runtime-config.json");
  const expectedPins = path.join(destinations.outputRoot, ".build", "python-packages.txt");
  if (destinations.configFile !== expectedConfig || destinations.pinsFile !== expectedPins) {
    fail("runtime config and Python pins must belong to the published runtime generation", {
      expectedConfig,
      expectedPins,
      configFile: destinations.configFile,
      pinsFile: destinations.pinsFile,
    });
  }
  const filesystemRoot = path.parse(destinations.outputRoot).root;
  if (destinations.outputRoot === filesystemRoot || destinations.outputRoot === REPOSITORY_ROOT) {
    fail("runtime staging output is too broad to replace", { path: destinations.outputRoot });
  }
  if (overlappingPaths(destinations.outputRoot, destinations.temporaryRoot, platform)) {
    fail("runtime staging output and temporary generation must be disjoint");
  }
  for (const destination of Object.values(destinations)) {
    for (const source of sources) {
      if (overlappingPaths(destination, source, platform)) {
        fail("runtime staging destinations must be disjoint from every input", { destination, source });
      }
    }
  }
}

async function loadApprovedPythonPackages(input, expectedOverride) {
  await assertFileDigest(
    input.pythonPackagesPath,
    input.pythonPackagesSha256,
    "Python package evidence",
  );
  const packages = (await readFile(input.pythonPackagesPath, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assertExactPythonPackages(packages, packages);
  if (expectedOverride) {
    assertExactPythonPackages(packages, expectedOverride);
  } else {
    const expectedCount = input.platform === "win32-x64" ? 57 : 55;
    if (packages.length !== expectedCount) {
      fail("approved Python package evidence has the wrong platform package count", {
        platform: input.platform,
        expected: expectedCount,
        actual: packages.length,
      });
    }
  }
  return packages;
}

export async function stageArtifactRuntime(paths, options = {}) {
  const normalizedPaths = {
    inputsFile: absolutePath(paths.inputsFile, "--inputs"),
    bootFile: absolutePath(paths.bootFile, "--boot"),
    outputRoot: absolutePath(paths.outputRoot, "--output"),
    configFile: absolutePath(paths.configFile, "--config"),
  };
  const expectedPlatform = options.hostTag ?? hostPlatformTag();
  const canonicalInputsFile = await assertRegularFile(
    normalizedPaths.inputsFile,
    "runtime staging input file",
    false,
  );
  const input = await readRuntimeInputs(canonicalInputsFile, expectedPlatform);
  const canonicalBootFile = await assertRegularFile(normalizedPaths.bootFile, "secondary CLI bundle", false);
  if (!contained(input.pythonRoot, input.pythonPath)) {
    fail("frozen Python interpreter must be contained in pythonRoot");
  }
  const vieneuWorker = path.join(input.vieneuRoot, "worker.py");
  const canonicalVieneuWorker = await assertContainedRegularFile(
    input.vieneuRoot,
    vieneuWorker,
    "frozen VieNeu worker",
  );
  if (input.cpythonVersion !== EXPECTED_CPYTHON_VERSION) {
    fail("CPython standalone build does not match the approved runtime", {
      expected: EXPECTED_CPYTHON_VERSION,
      actual: input.cpythonVersion,
    });
  }
  if (input.ffmpegVersion !== input.ffprobeVersion) {
    fail("approved FFmpeg and FFprobe version pins do not match", {
      ffmpeg: input.ffmpegVersion,
      ffprobe: input.ffprobeVersion,
    });
  }
  await Promise.all([
    assertFileDigest(input.ffmpegPath, input.ffmpegSha256, "FFmpeg input"),
    assertFileDigest(input.ffprobePath, input.ffprobeSha256, "FFprobe input"),
    assertFileDigest(input.pythonPath, input.pythonSha256, "CPython input"),
    assertFileDigest(
      input.pythonPackagesPath,
      input.pythonPackagesSha256,
      "Python package evidence",
    ),
    assertFileDigest(canonicalVieneuWorker, input.vieneuWorkerSha256, "VieNeu worker input"),
    materializedTreeSha256(input.pythonRoot).then((actual) => {
      if (actual !== input.pythonTreeSha256) {
        fail("frozen Python tree does not match its approved digest", {
          expected: input.pythonTreeSha256,
          actual,
        });
      }
    }),
  ]);
  const hyperframesRoot = await assertRealDirectory(
    options.hyperframesRoot ?? await defaultHyperframesRoot(),
    "HyperFrames package root",
  );
  const packageNames = nativePackageNamesFor(input.platform);
  const nativePackageRoots = options.nativePackageRoots
    ?? await resolveNativePackageRoots(hyperframesRoot, input.platform);
  const libraries = options.motionLibraries ?? await defaultMotionLibraries();
  const motionPackageRoots = options.motionPackageRoots ?? await defaultMotionPackageRoots(libraries);
  const expectedPythonPackages = await loadApprovedPythonPackages(
    input,
    options.expectedPythonPackages,
  );
  const canonicalNativePackageRoots = new Map(await Promise.all(packageNames.map(async (packageName) => {
    const packageRoot = nativePackageRoots.get(packageName);
    if (!packageRoot) fail(`native package root is missing for ${packageName}`);
    return [packageName, await assertRealDirectory(packageRoot, `${packageName} package root`)];
  })));
  const canonicalMotionPackageRoots = new Map(await Promise.all(libraries.map(async (library) => {
    const packageRoot = motionPackageRoots.get(library.packageName);
    if (!packageRoot) fail(`motion package root is missing for ${library.packageName}`);
    return [
      library.packageName,
      await assertRealDirectory(packageRoot, `${library.packageName} motion package root`),
    ];
  })));
  const drizzleRoot = options.drizzleRoot
    ?? path.join(REPOSITORY_ROOT, "packages", "adapter", "drizzle");
  const canonicalDrizzleRoot = await assertRealDirectory(drizzleRoot, "Drizzle migration root");

  const temporaryRoot = `${normalizedPaths.outputRoot}.${process.pid}.${randomUUID()}.tmp`;
  const pinsFile = path.join(normalizedPaths.outputRoot, ".build", "python-packages.txt");
  const destinations = {
    outputRoot: normalizedPaths.outputRoot,
    temporaryRoot,
    configFile: normalizedPaths.configFile,
    pinsFile,
  };
  const sources = [...new Set([
    canonicalInputsFile,
    canonicalBootFile,
    input.ffmpegPath,
    input.ffprobePath,
    input.pythonRoot,
    input.pythonPath,
    input.pythonPackagesPath,
    input.vieneuRoot,
    canonicalVieneuWorker,
    hyperframesRoot,
    canonicalDrizzleRoot,
    ...canonicalNativePackageRoots.values(),
    ...canonicalMotionPackageRoots.values(),
  ])];
  await inspectWriteAuthority(normalizedPaths.outputRoot, "runtime staging output");
  await assertSafeBuildPaths(destinations, sources, input.platform);
  await recoverRuntimeGeneration(normalizedPaths.outputRoot);

  const nodeRoot = path.join(temporaryRoot, "node");
  const hyperframesStageRoot = path.join(temporaryRoot, "hyperframes");
  const bgmStageRoot = path.join(temporaryRoot, "bgm");
  try {
    const probeRoot = path.join(temporaryRoot, ".probe");
    const probeHome = path.join(probeRoot, "home");
    const probeTemporary = path.join(probeRoot, "tmp");
    await mkdir(probeHome, { recursive: true });
    await mkdir(probeTemporary, { recursive: true });
    const probeEnvironment = privateProbeEnvironment(probeHome, probeTemporary);
    await inspectDarwinBinary(input.ffmpegPath, "FFmpeg", probeEnvironment);
    await inspectDarwinBinary(input.ffprobePath, "FFprobe", probeEnvironment);

    await mkdir(path.join(nodeRoot, "cli"), { recursive: true });
    await copyFile(canonicalBootFile, path.join(nodeRoot, "cli", "boot.cjs"));

    await mkdir(path.join(nodeRoot, "bin"), { recursive: true });
    const suffix = input.platform === "win32-x64" ? ".exe" : "";
    const stagedFfmpeg = path.join(nodeRoot, "bin", `ffmpeg${suffix}`);
    const stagedFfprobe = path.join(nodeRoot, "bin", `ffprobe${suffix}`);
    await copyFile(input.ffmpegPath, stagedFfmpeg);
    await copyFile(input.ffprobePath, stagedFfprobe);
    await chmod(stagedFfmpeg, 0o755);
    await chmod(stagedFfprobe, 0o755);

    const stagedPythonRoot = path.join(nodeRoot, "python");
    await copyContainedTree(input.pythonRoot, stagedPythonRoot);
    await prunePythonBuildTools(stagedPythonRoot);
    const relativeInterpreter = path.relative(input.pythonRoot, input.pythonPath);
    const copiedInterpreter = path.join(stagedPythonRoot, relativeInterpreter);
    const stagedPython = input.platform === "win32-x64"
      ? path.join(stagedPythonRoot, "python.exe")
      : path.join(stagedPythonRoot, "bin", "python3");
    if (!existsSync(stagedPython)) {
      await mkdir(path.dirname(stagedPython), { recursive: true });
      await copyFile(copiedInterpreter, stagedPython);
    }
    await chmod(stagedPython, 0o755);
    const stagedPythonTreeSha256 = await materializedTreeSha256(stagedPythonRoot);
    if (stagedPythonTreeSha256 !== input.pythonRuntimeTreeSha256) {
      fail("staged Python runtime tree does not match its approved post-prune digest", {
        expected: input.pythonRuntimeTreeSha256,
        actual: stagedPythonTreeSha256,
      });
    }

    const stagedVieneuRoot = path.join(nodeRoot, "vieneu");
    await mkdir(stagedVieneuRoot, { recursive: true });
    await copyFile(canonicalVieneuWorker, path.join(stagedVieneuRoot, "worker.py"));
    await stageDrizzleMigrations(canonicalDrizzleRoot, path.join(nodeRoot, "drizzle"));

    const esbuildPlatformPackage = {
      "darwin-arm64": "@esbuild/darwin-arm64",
      "linux-x64": "@esbuild/linux-x64",
      "win32-x64": "@esbuild/win32-x64",
    }[input.platform];
    const esbuildPlatformRoot = canonicalNativePackageRoots.get(esbuildPlatformPackage);
    if (!esbuildPlatformRoot) fail("host esbuild package is missing", { package: esbuildPlatformPackage });
    const esbuildSource = path.join(
      esbuildPlatformRoot,
      esbuildPlatformBinaryRelative(input.platform),
    );
    const canonicalEsbuild = await assertContainedRegularFile(
      esbuildPlatformRoot,
      esbuildSource,
      "esbuild binary",
      true,
      // Bun may hard-link package inputs from its global cache on Linux. The
      // source is read-only build input; the staged release copy below still
      // has one link and remains the provenance authority.
      true,
    );
    const stagedEsbuild = path.join(nodeRoot, "bin", `esbuild${suffix}`);
    await copyFile(canonicalEsbuild, stagedEsbuild);
    await chmod(stagedEsbuild, 0o755);

    const hyperframes = await stageHyperframes({
      root: hyperframesStageRoot,
      sourceRoot: hyperframesRoot,
      libraries,
      motionPackageRoots: canonicalMotionPackageRoots,
      bundle: options.bundleHyperframes ?? bundleHyperframesCli,
    });
    await copyNativeClosure(
      canonicalNativePackageRoots,
      packageNames,
      input.platform,
      nodeRoot,
      hyperframesStageRoot,
    );
    const nativeProbe = options.probeNativeClosure ?? probeStagedNativeClosure;
    await nativeProbe(nodeRoot, probeEnvironment);
    await nativeProbe(hyperframesStageRoot, probeEnvironment);

    const probes = await (options.probeRuntime ?? probeStagedRuntime)(
      {
        ffmpegPath: stagedFfmpeg,
        ffprobePath: stagedFfprobe,
        pythonPath: stagedPython,
        esbuildPath: stagedEsbuild,
      },
      probeEnvironment,
    );
    await Promise.all([
      assertFileDigest(stagedFfmpeg, input.ffmpegSha256, "staged FFmpeg"),
      assertFileDigest(stagedFfprobe, input.ffprobeSha256, "staged FFprobe"),
      assertFileDigest(stagedPython, input.pythonSha256, "staged CPython"),
      assertFileDigest(
        path.join(nodeRoot, "vieneu", "worker.py"),
        input.vieneuWorkerSha256,
        "staged VieNeu worker",
      ),
    ]);
    const requiredNodeVersion = options.requiredNodeVersion ?? EXPECTED_NODE_VERSION;
    if (process.versions.node !== requiredNodeVersion) {
      fail("the build Node does not match the approved SEA runtime", {
        expected: requiredNodeVersion,
        actual: process.versions.node,
      });
    }
    if (probes.vieneu !== EXPECTED_VIENEU_VERSION) {
      fail("VieNeu version does not match the approved runtime", {
        expected: EXPECTED_VIENEU_VERSION,
        actual: probes.vieneu,
      });
    }
    if (probes.ffmpeg !== input.ffmpegVersion || probes.ffprobe !== input.ffprobeVersion) {
      fail("staged media versions do not match their approved pins", {
        expected: { ffmpeg: input.ffmpegVersion, ffprobe: input.ffprobeVersion },
        actual: { ffmpeg: probes.ffmpeg, ffprobe: probes.ffprobe },
      });
    }
    const languageVersion = input.cpythonVersion.split("+", 1)[0];
    if (probes.cpython !== languageVersion) {
      fail("staged CPython language version does not match its standalone build pin", {
        expected: languageVersion,
        actual: probes.cpython,
      });
    }
    assertExactPythonPackages(probes.pythonPackages, expectedPythonPackages);

    const esbuildManifest = await readPackageManifest(canonicalNativePackageRoots.get("esbuild"), "esbuild");
    if (probes.esbuild !== esbuildManifest.version) {
      fail("esbuild binary does not match its JavaScript package", {
        binary: probes.esbuild,
        package: esbuildManifest.version,
      });
    }
    const nodePtyManifest = await readPackageManifest(canonicalNativePackageRoots.get("node-pty"), "node-pty");
    if (nodePtyManifest.version !== EXPECTED_NODE_PTY_VERSION) {
      fail("node-pty does not match the approved runtime", {
        expected: EXPECTED_NODE_PTY_VERSION,
        actual: nodePtyManifest.version,
      });
    }
    // The shipped BGM audio, staged as its own generation: an artifact has no
    // `packages/adapter/assets`, so a build that skipped this would list four
    // tracks and fail to read any of them.
    await mkdir(bgmStageRoot, { recursive: true });
    const bgmSourceRoot = path.join(REPOSITORY_ROOT, "packages", "adapter", "assets", "bgm");
    const bgmFiles = (await readdir(bgmSourceRoot)).filter((name) => name.endsWith(".mp3")).sort();
    if (bgmFiles.length === 0) {
      fail("no shipped BGM audio was found to stage", { source: bgmSourceRoot });
    }
    for (const name of bgmFiles) {
      await copyFile(path.join(bgmSourceRoot, name), path.join(bgmStageRoot, name));
    }

    const config = {
      artifactVersion: input.artifactVersion,
      versions: {
        node: process.versions.node,
        hyperframes: hyperframes.version,
        esbuild: probes.esbuild,
        ffmpeg: probes.ffmpeg,
        cpython: input.cpythonVersion,
        vieneu: probes.vieneu,
        motion: hyperframes.motion,
      },
      pythonPackages: { [input.platform]: pinsFile },
      archives: [
        {
          key: "hyperframes",
          platform: input.platform,
          source: path.join(normalizedPaths.outputRoot, "hyperframes"),
          target: "hyperframes",
        },
        {
          key: "node",
          platform: input.platform,
          source: path.join(normalizedPaths.outputRoot, "node"),
          target: "native",
        },
        {
          key: "bgm",
          platform: input.platform,
          source: path.join(normalizedPaths.outputRoot, "bgm"),
          target: "bgm",
        },
      ],
    };
    const temporaryBuildRoot = path.join(temporaryRoot, ".build");
    await mkdir(temporaryBuildRoot, { recursive: true });
    await writeFile(
      path.join(temporaryBuildRoot, "python-packages.txt"),
      `${probes.pythonPackages.join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(temporaryBuildRoot, "runtime-config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rm(probeRoot, { recursive: true });
    await walkRegularTree(temporaryRoot);
    const topLevel = (await readdir(temporaryRoot)).sort();
    if (JSON.stringify(topLevel) !== JSON.stringify([".build", "bgm", "hyperframes", "node"])) {
      fail("runtime staging root must contain exactly one complete build generation", { topLevel });
    }
    await commitRuntimeGeneration(
      temporaryRoot,
      normalizedPaths.outputRoot,
      options.publishHooks,
    );
    return { config, pinsFile, outputRoot: normalizedPaths.outputRoot };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function commandLine(argv) {
  if (argv.length !== 8) {
    fail("usage: stage-artifact-runtime --inputs <file> --boot <file> --output <directory> --config <file>");
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--inputs", "--boot", "--output", "--config"].includes(flag) || values.has(flag)) {
      fail("usage: stage-artifact-runtime --inputs <file> --boot <file> --output <directory> --config <file>");
    }
    values.set(flag, value);
  }
  return {
    inputsFile: absolutePath(values.get("--inputs"), "--inputs"),
    bootFile: absolutePath(values.get("--boot"), "--boot"),
    outputRoot: absolutePath(values.get("--output"), "--output"),
    configFile: absolutePath(values.get("--config"), "--config"),
  };
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  Promise.resolve().then(() => stageArtifactRuntime(commandLine(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify({ output: result.outputRoot, config: result.config })}\n`);
  }).catch((error) => {
    process.stderr.write(`stage-artifact-runtime: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
