import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  commitDirectoryGeneration,
  recoverDirectoryGeneration,
} from "./directory-generation-publish.mjs";

const requireFromAdapter = createRequire(new URL("../packages/adapter/package.json", import.meta.url));
const { create: createTar } = requireFromAdapter("tar");
const requireFromCli = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const { tsImport } = requireFromCli("tsx/esm/api");

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_EVIDENCE_ROOT = path.join(
  REPOSITORY_ROOT,
  "spikes/phase-4/s9-windows-runtime/evidence",
);
const PLATFORM_TAGS = ["darwin-arm64", "win32-x64", "linux-x64"];
const MOTION_PACKAGES = ["animejs", "gsap", "lottie-web", "motion", "three"];
const ARCHIVE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const ARTIFACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const READY_NAMESPACE_PATTERN = /^\.ready-/iu;
const WINDOWS_FORBIDDEN_PATH_CHARACTER_PATTERN = /[<>:"|?*\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const RUNTIME_CURRENT_FILENAME = "current.json";
const RUNTIME_MANIFEST_FILENAME = "runtime-manifest.json";
const MAX_RUNTIME_RELATIVE_PATH_LENGTH = 1024;
const MAX_RUNTIME_PATH_SEGMENT_BYTES = 255;
const EPOCH = new Date(0);

const EVIDENCE_FILES = {
  "darwin-arm64": {
    names: "darwin-package-set-pruned.txt",
    versions: "darwin-package-set.txt",
  },
  "win32-x64": {
    names: "win-package-set-pruned.txt",
    versions: "win-package-set-pruned.txt",
  },
  "linux-x64": {
    names: "linux-package-set-pruned.txt",
    versions: "linux-package-set.txt",
  },
};

function fail(message, details) {
  const error = new Error(details ? `${message}: ${JSON.stringify(details)}` : message);
  error.details = details;
  throw error;
}

function record(value, label) {
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

function manifestString(value, label) {
  const text = canonicalString(value, label);
  if (text.length > 128) fail(`${label} must be no longer than 128 characters`);
  return text;
}

function portablePathSegment(segment) {
  return segment.length > 0
    && Buffer.byteLength(segment, "utf8") <= MAX_RUNTIME_PATH_SEGMENT_BYTES
    && segment !== "."
    && segment !== ".."
    && !segment.endsWith(".")
    && !segment.endsWith(" ")
    && !WINDOWS_FORBIDDEN_PATH_CHARACTER_PATTERN.test(segment)
    && !WINDOWS_RESERVED_DEVICE_PATTERN.test(segment);
}

function portableRelativePath(value, label) {
  const pathname = canonicalString(value, label);
  const segments = pathname.split("/");
  if (
    pathname.length > MAX_RUNTIME_RELATIVE_PATH_LENGTH
    || pathname.includes("\\")
    || pathname.endsWith("/")
    || path.posix.isAbsolute(pathname)
    || path.win32.isAbsolute(pathname)
    || path.posix.normalize(pathname) !== pathname
    || segments.some((part) => !portablePathSegment(part))
  ) {
    fail(`${label} must be a normalized portable relative path`, { path: pathname });
  }
  return pathname;
}

function ownershipPath(pathname, platform) {
  if (platform === "linux-x64") return pathname;
  return (platform === "darwin-arm64" ? pathname.normalize("NFC") : pathname).toLowerCase();
}

function declaredParentPath(paths, child) {
  let parent = path.posix.dirname(child);
  while (parent !== ".") {
    if (paths.has(parent)) return parent;
    parent = path.posix.dirname(parent);
  }
  return undefined;
}

function assertNoOwnedPathOverlap(pathnames, platform, label) {
  const originals = new Map();
  for (const pathname of pathnames) {
    const owned = ownershipPath(pathname, platform);
    const previous = originals.get(owned);
    if (previous !== undefined) fail(`${label} overlap`, { current: previous, next: pathname });
    originals.set(owned, pathname);
  }
  const paths = new Set(originals.keys());
  for (const [ownedChild, child] of originals) {
    const ownedParent = declaredParentPath(paths, ownedChild);
    if (ownedParent !== undefined) {
      fail(`${label} overlap`, { current: originals.get(ownedParent), next: child });
    }
  }
}

export function normalizePythonPackageName(name) {
  return canonicalString(name, "python package name").toLowerCase().replaceAll("_", "-");
}

function parsePythonPin(line, source) {
  const separator = line.indexOf("==");
  if (separator <= 0 || separator !== line.lastIndexOf("==")) {
    fail(`python package evidence must use exact name==version pins`, { source, line });
  }
  const name = normalizePythonPackageName(line.slice(0, separator));
  const version = canonicalString(line.slice(separator + 2), `python package version in ${source}`);
  return { name, version, pin: `${name}==${version}` };
}

async function evidenceLines(filename) {
  return (await readFile(filename, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function expectedForPlatform(platform, evidenceRoot) {
  const files = EVIDENCE_FILES[platform];
  if (!files) fail(`unsupported runtime platform ${platform}`, { supported: PLATFORM_TAGS });
  const namesPath = path.join(evidenceRoot, files.names);
  const versionsPath = path.join(evidenceRoot, files.versions);
  const nameLines = await evidenceLines(namesPath);
  const expectedNames = new Set(nameLines.map((line) => normalizePythonPackageName(line.split("==", 1)[0])));
  expectedNames.delete("pip");

  const versionPins = new Map();
  for (const line of await evidenceLines(versionsPath)) {
    const parsed = parsePythonPin(line, versionsPath);
    if (versionPins.has(parsed.name)) fail(`duplicate python package evidence for ${parsed.name}`, { platform });
    versionPins.set(parsed.name, parsed);
  }
  const pins = [...expectedNames].sort().map((name) => {
    const pin = versionPins.get(name);
    if (!pin) fail(`python evidence is missing a version for ${name}`, { platform });
    return pin.pin;
  });
  return pins;
}

/** Loads the measured, platform-specific package pins without duplicating them in build code. */
export async function loadExpectedPythonPackages(evidenceRoot = DEFAULT_EVIDENCE_ROOT) {
  const expected = Object.fromEntries(await Promise.all(PLATFORM_TAGS.map(async (platform) => [
    platform,
    await expectedForPlatform(platform, evidenceRoot),
  ])));
  const linuxNames = expected["linux-x64"].map((pin) => pin.split("==", 1)[0]);
  const darwinNames = expected["darwin-arm64"].map((pin) => pin.split("==", 1)[0]);
  if (linuxNames.length !== 55 || JSON.stringify(linuxNames) !== JSON.stringify(darwinNames)) {
    fail("darwin and Linux evidence must describe the same 55-package core", {
      darwinCount: darwinNames.length,
      linuxCount: linuxNames.length,
    });
  }
  const windowsNames = expected["win32-x64"].map((pin) => pin.split("==", 1)[0]);
  const expectedWindowsNames = [...linuxNames, "colorama", "tzdata"].sort();
  if (windowsNames.length !== 57 || JSON.stringify(windowsNames) !== JSON.stringify(expectedWindowsNames)) {
    fail("Windows evidence must equal the 55-package core plus colorama and tzdata", {
      windowsCount: windowsNames.length,
    });
  }
  for (const pins of Object.values(expected)) {
    if (pins.some((pin) => pin.startsWith("pip=="))) fail("pip must not be shipped in a runtime archive");
  }
  return expected;
}

function pinsByName(lines, source) {
  const pins = new Map();
  for (const line of lines) {
    const parsed = parsePythonPin(line, source);
    if (pins.has(parsed.name)) fail(`duplicate python package ${parsed.name}`, { source });
    pins.set(parsed.name, parsed.version);
  }
  return pins;
}

/** Fails on one extra/missing package, on pip, or on any exact-version drift. */
export async function verifyPythonPackageSet({
  platform,
  actualFile,
  expectedPackages,
}) {
  if (!PLATFORM_TAGS.includes(platform)) fail(`unsupported runtime platform ${platform}`, { supported: PLATFORM_TAGS });
  const actual = pinsByName(await evidenceLines(actualFile), actualFile);
  if (actual.has("pip")) fail(`pip must not be present in the shipped ${platform} Python stack`);
  const expected = pinsByName(expectedPackages[platform], `expected ${platform} package set`);
  const missing = [...expected.keys()].filter((name) => !actual.has(name)).sort();
  const unexpected = [...actual.keys()].filter((name) => !expected.has(name)).sort();
  const versionMismatches = [...expected.entries()]
    .filter(([name, version]) => actual.has(name) && actual.get(name) !== version)
    .map(([name, expectedVersion]) => ({ name, expected: expectedVersion, actual: actual.get(name) }));
  if (missing.length || unexpected.length || versionMismatches.length) {
    fail(`Python package set mismatch for ${platform}`, { missing, unexpected, versionMismatches });
  }
  return expectedPackages[platform];
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/** A locale-independent total order matching the bytes ultimately written to tar. */
function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function walkRegularFiles(root) {
  const files = [];
  const visit = async (directory, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = portableRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        "runtime archive source path",
      );
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail(`runtime archive source contains a symlink`, { path: relative });
      if (metadata.isDirectory()) {
        await visit(absolute, relative);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) fail(`runtime archive source contains a hard-linked file`, { path: relative });
        if (READY_NAMESPACE_PATTERN.test(relative.split("/", 1)[0] ?? "")) {
          fail(`runtime archive source collides with the ready-marker namespace`, { path: relative });
        }
        files.push({
          path: relative,
          sha256: await hashFile(absolute),
          mode: metadata.mode & 0o777,
        });
      } else {
        fail(`runtime archive source contains a special file`, { path: relative });
      }
    }
  };
  await visit(root);
  if (files.length === 0) fail(`runtime archive source ${root} contains no regular files`);
  return files;
}

async function buildArchive({ source, destination, entries }) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await createTar({
      cwd: source,
      file: temporary,
      gzip: { level: 9 },
      mtime: EPOCH,
      portable: true,
      strict: true,
      noDirRecurse: true,
    }, entries.map((entry) => entry.path));
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function runtimeAssetsBackup(outputRoot) {
  return `${outputRoot}.previous`;
}

export async function recoverRuntimeAssetPublish(outputRoot) {
  const output = path.resolve(outputRoot);
  return recoverDirectoryGeneration({
    kind: "runtime-assets",
    published: output,
    backup: runtimeAssetsBackup(output),
    authorityFile: "runtime-manifest.json",
  });
}

export async function commitRuntimeAssetGeneration(generationRoot, outputRoot, options = {}) {
  const generation = path.resolve(generationRoot);
  const output = path.resolve(outputRoot);
  return commitDirectoryGeneration({
    kind: "runtime-assets",
    published: output,
    backup: runtimeAssetsBackup(output),
    generation,
    authorityFile: "runtime-manifest.json",
    onBoundary: options.onBoundary,
  });
}

function parseVersions(value) {
  const versions = record(value, "config.versions");
  exactKeys(versions, ["node", "hyperframes", "esbuild", "ffmpeg", "cpython", "vieneu", "motion"], "config.versions");
  const motion = record(versions.motion, "config.versions.motion");
  exactKeys(motion, MOTION_PACKAGES, "config.versions.motion");
  return {
    node: manifestString(versions.node, "Node version"),
    hyperframes: manifestString(versions.hyperframes, "HyperFrames version"),
    esbuild: manifestString(versions.esbuild, "esbuild version"),
    ffmpeg: manifestString(versions.ffmpeg, "FFmpeg version"),
    cpython: manifestString(versions.cpython, "CPython version"),
    vieneu: manifestString(versions.vieneu, "VieNeu version"),
    motion: Object.fromEntries(MOTION_PACKAGES.map((name) => [name, manifestString(motion[name], `${name} version`)])),
  };
}

async function parseConfig(configFile) {
  const config = record(JSON.parse(await readFile(configFile, "utf8")), "runtime archive config");
  exactKeys(config, ["artifactVersion", "versions", "pythonPackages", "archives"], "runtime archive config");
  const artifactVersion = canonicalString(config.artifactVersion, "artifactVersion");
  if (
    artifactVersion.length > 128
    || !ARTIFACT_VERSION_PATTERN.test(artifactVersion)
    || artifactVersion.toLowerCase() === RUNTIME_CURRENT_FILENAME
    || !portablePathSegment(artifactVersion)
  ) fail("artifactVersion must be a portable path segment");
  const packages = record(config.pythonPackages, "config.pythonPackages");
  for (const platform of Object.keys(packages)) {
    if (!PLATFORM_TAGS.includes(platform)) fail(`config.pythonPackages contains unsupported platform ${platform}`);
    packages[platform] = path.resolve(path.dirname(configFile), canonicalString(packages[platform], `pythonPackages.${platform}`));
  }
  if (!Array.isArray(config.archives) || config.archives.length === 0) fail("config.archives must be non-empty");
  const keys = new Set();
  const archives = config.archives.map((candidate, index) => {
    const archive = record(candidate, `config.archives[${index}]`);
    exactKeys(archive, ["key", "platform", "source", "target"], `config.archives[${index}]`);
    const key = canonicalString(archive.key, `config.archives[${index}].key`);
    if (
      key.length > 128
      || !ARCHIVE_KEY_PATTERN.test(key)
      || !portablePathSegment(key)
      || key === RUNTIME_MANIFEST_FILENAME
      || keys.has(key)
    ) fail(`archive key ${key} must be unique and portable`);
    keys.add(key);
    const platform = canonicalString(archive.platform, `archive ${key} platform`);
    if (!PLATFORM_TAGS.includes(platform)) fail(`archive ${key} has unsupported platform ${platform}`);
    const target = portableRelativePath(archive.target, `archive ${key} target`);
    const targetNamespace = target.split("/", 1)[0]?.toLowerCase();
    if (targetNamespace === RUNTIME_MANIFEST_FILENAME || targetNamespace === RUNTIME_CURRENT_FILENAME) {
      fail(`archive ${key} target collides with the installed runtime metadata namespace`, { target });
    }
    return {
      key,
      platform,
      source: path.resolve(path.dirname(configFile), canonicalString(archive.source, `archive ${key} source`)),
      target,
    };
  });
  for (const platform of PLATFORM_TAGS) {
    assertNoOwnedPathOverlap(
      archives.filter((archive) => archive.platform === platform).map((archive) => archive.target),
      platform,
      `runtime archive targets on ${platform}`,
    );
  }
  return { artifactVersion, versions: parseVersions(config.versions), packages, archives };
}

/** Builds deterministic archives plus the build-authoritative runtime manifest. */
export async function buildRuntimeArchives({ configFile, outputRoot, evidenceRoot = DEFAULT_EVIDENCE_ROOT }) {
  const config = await parseConfig(path.resolve(configFile));
  const expectedPackages = await loadExpectedPythonPackages(path.resolve(evidenceRoot));
  for (const platform of new Set(config.archives.map((archive) => archive.platform))) {
    const actualFile = config.packages[platform];
    if (!actualFile) fail(`config.pythonPackages is missing ${platform}`);
    await verifyPythonPackageSet({ platform, actualFile, expectedPackages });
  }

  const output = path.resolve(outputRoot);
  await mkdir(path.dirname(output), { recursive: true });
  await recoverRuntimeAssetPublish(output);
  const generation = `${output}.build-${process.pid}-${randomUUID()}`;
  await rm(generation, { recursive: true, force: true });
  const archiveRoot = path.join(generation, "runtime-archives");
  const manifestArchives = [];
  try {
    for (const archive of [...config.archives].sort((left, right) => compareUtf8(left.key, right.key))) {
      const sourceStat = await lstat(archive.source);
      if (!sourceStat.isDirectory()) fail(`archive source must be a directory`, { source: archive.source });
      const entries = await walkRegularFiles(archive.source);
      assertNoOwnedPathOverlap(
        entries.map((entry) => entry.path),
        archive.platform,
        `runtime archive entries for ${archive.key}`,
      );
      const destination = path.join(archiveRoot, `${archive.key}.tar.gz`);
      await buildArchive({ source: archive.source, destination, entries });
      const archiveStat = await stat(destination);
      manifestArchives.push({
        key: archive.key,
        platform: archive.platform,
        sha256: await hashFile(destination),
        bytes: archiveStat.size,
        target: archive.target,
        entries,
      });
    }

    const manifest = {
      schemaVersion: 1,
      artifactVersion: config.artifactVersion,
      versions: config.versions,
      pythonPackages: expectedPackages,
      archives: manifestArchives,
    };
    // The runtime parser is the final authority. Running the emitted projection
    // through it here prevents duplicated build validation from drifting into an
    // artifact that succeeds at build time but cannot boot.
    const { parseEmbeddedRuntimeManifest } = await tsImport(
      "../packages/adapter/src/runtime/runtime-asset-source.ts",
      import.meta.url,
    );
    parseEmbeddedRuntimeManifest(manifest);
    await mkdir(generation, { recursive: true });
    await writeFile(
      path.join(generation, "runtime-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await commitRuntimeAssetGeneration(generation, output);
    return manifest;
  } finally {
    await rm(generation, { recursive: true, force: true });
  }
}

function commandLine(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail("usage: build-runtime-archives --config <file> --output <directory> [--evidence-root <directory>]");
    values.set(flag, value);
  }
  const configFile = values.get("--config");
  const outputRoot = values.get("--output");
  if (!configFile || !outputRoot || [...values.keys()].some((key) => !["--config", "--output", "--evidence-root"].includes(key))) {
    fail("usage: build-runtime-archives --config <file> --output <directory> [--evidence-root <directory>]");
  }
  return { configFile, outputRoot, evidenceRoot: values.get("--evidence-root") };
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  buildRuntimeArchives(commandLine(process.argv.slice(2))).then((manifest) => {
    process.stdout.write(`${JSON.stringify({
      manifest: "runtime-manifest.json",
      archives: manifest.archives.map((archive) => archive.key),
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
