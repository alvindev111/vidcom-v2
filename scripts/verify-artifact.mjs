import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertBuildableTarget } from "./build-artifact.mjs";
import {
  PRODUCT_MIGRATION_PATHS,
  motionRuntimePaths,
} from "./artifact-runtime-contract.mjs";
import {
  ARTIFACT_BUILD_AUTHORITY_FILE,
  artifactBuildDirectory,
  artifactBuildPath,
  artifactPath,
  commitArtifactBuild,
  revalidateArtifactBuildAuthority,
  restoreArtifactBuildAuthority,
} from "./artifact-publish.mjs";
import {
  buildRootEncodings,
  containsBuildRootEncoding,
} from "./build-root-provenance.mjs";
import { BUNDLE_PATH } from "./build-cli-bundle.mjs";
import { MANIFEST_PATH, PACK_PATH } from "./build-frontend-pack.mjs";
import {
  REPOSITORY_ROOT,
  runtimeAssetRoot,
  runtimeStageRoot,
} from "./artifact-layout.mjs";
import {
  POSTJECT,
  SEA_PRIMARY_BUNDLE_ASSET,
  assertSeaInputSnapshot,
  hostRuntimeArchives,
} from "./build-sea.mjs";
import { verifySeaPreparationBlob } from "./sea-blob.mjs";
import { verifyActiveSeaResource } from "./sea-resource.mjs";
import { exactSeaBuildSeal, parseSeaBuildSeal, verifySeaBuildSeal } from "./sea-build-seal.mjs";

const SHA256 = /^sha256:([0-9a-f]{64})$/u;
const FORBIDDEN_RUNTIME_EXTENSION = /(?:\.d\.(?:c|m)?ts|\.(?:ts|tsx|map))$/iu;
const FORBIDDEN_RUNTIME_DIRECTORY = new Set(["__tests__", "build", "source", "sources", "src", "test", "tests"]);
const COMMON_NATIVE_PACKAGES = [
  "@img/colour",
  "detect-libc",
  "esbuild",
  "onnxruntime-common",
  "onnxruntime-node",
  "semver",
  "sharp",
];
const PLATFORM_NATIVE_PACKAGES = {
  "darwin-arm64": [
    "@esbuild/darwin-arm64",
    "@img/sharp-darwin-arm64",
    "@img/sharp-libvips-darwin-arm64",
  ],
  "linux-x64": [
    "@esbuild/linux-x64",
    "@img/sharp-linux-x64",
    "@img/sharp-libvips-linux-x64",
  ],
  "win32-x64": ["@esbuild/win32-x64", "@img/sharp-win32-x64"],
};
const requireFromAdapter = createRequire(new URL("../packages/adapter/package.json", import.meta.url));
const { extract: extractTar, list: listTar } = requireFromAdapter("tar");
const requireFromCli = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const { tsImport } = requireFromCli("tsx/esm/api");

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`verify-artifact: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

/**
 * What must never be in a shipped file.
 *
 * Each is a thing that is invisible until it is embarrassing: a key that works,
 * a sourcemap that hands over the whole source, a development origin that makes
 * the artifact talk to a machine that is not there, and the build machine's own
 * directory layout.
 */
export const FORBIDDEN_PATTERNS = [
  { id: "dev-origin", pattern: /localhost:3000/u, why: "a development origin cannot be reachable from a user's machine" },
  { id: "sourcemap-url", pattern: /(?:\/\/|\/\*)\s*[#@]\s*sourceMappingURL\s*=/u, why: "a sourcemap hands over the entire original source" },
  { id: "aws-key", pattern: /AKIA[0-9A-Z]{16}/u, why: "an AWS access key" },
  {
    id: "openai-key",
    // OpenSSH names two FIDO key algorithms with the same `sk-` prefix. Match
    // API-key-shaped text without treating those exact standard identifiers as
    // credentials when a media binary links libssh.
    pattern: /\bsk-(?!ant-|ssh-ed25519(?:-cert-v01)?@openssh\.com|ecdsa-sha2-nistp256(?:-cert-v01)?@openssh\.com)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/u,
    why: "an OpenAI API key",
  },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/u, why: "an Anthropic API key" },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u, why: "a GitHub token" },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{20,}/u, why: "a Hugging Face token" },
  {
    id: "private-key",
    // A valid PEM/OpenSSH key continues on the next line. Crypto libraries
    // legitimately embed the header alone as a NUL-terminated parser literal.
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n/u,
    why: "a private key",
  },
];

/**
 * Scans text for anything that must not ship.
 *
 * Returns every hit rather than the first: a build that leaked two things
 * should say so once, not across two runs.
 */
export function scanForForbidden(text, buildRoot) {
  const found = [];
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(text)) found.push({ id: rule.id, why: rule.why });
  }
  if (containsBuildRootEncoding(text, buildRoot)) {
    found.push({
      id: "build-root",
      why: "the build machine's absolute path says nothing about the user's install",
    });
  }
  return found;
}

function occurrenceSignature(occurrence) {
  return `${occurrence.id}:${occurrence.offset}:${occurrence.digest}`;
}

/** Binary-safe, bounded scan which retains exact byte offsets for baseline comparison. */
export async function forbiddenFileOccurrences(filename, buildRoot) {
  const rootBuffers = buildRootEncodings(buildRoot).map((value) => Buffer.from(value, "utf8"));
  const overlap = Math.max(256, ...rootBuffers.map((value) => value.length + 64));
  const found = new Map();
  let tail = Buffer.alloc(0);
  let consumed = 0;
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 })) {
    const bytes = Buffer.concat([tail, chunk]);
    const baseOffset = consumed - tail.length;
    const text = bytes.toString("latin1");
    for (const rule of FORBIDDEN_PATTERNS) {
      const expression = new RegExp(rule.pattern.source, `${rule.pattern.flags.replaceAll("g", "")}g`);
      for (const match of text.matchAll(expression)) {
        const occurrence = {
          id: rule.id,
          why: rule.why,
          offset: baseOffset + (match.index ?? 0),
          digest: createHash("sha256").update(match[0], "latin1").digest("hex"),
        };
        found.set(occurrenceSignature(occurrence), occurrence);
      }
    }
    for (const root of rootBuffers) {
      let cursor = 0;
      while (cursor <= bytes.length - root.length) {
        const index = bytes.indexOf(root, cursor);
        if (index === -1) break;
        const occurrence = {
          id: "build-root",
          why: "the build machine's absolute path says nothing about the user's install",
          offset: baseOffset + index,
          digest: createHash("sha256").update(root).digest("hex"),
        };
        found.set(occurrenceSignature(occurrence), occurrence);
        cursor = index + 1;
      }
    }
    tail = bytes.subarray(Math.max(0, bytes.length - overlap));
    consumed += chunk.length;
  }
  return [...found.values()].sort((left, right) => left.offset - right.offset || compareUtf8(left.id, right.id));
}

/** Binary-safe, bounded scan used for runtime files and large archives. */
export async function scanFileForForbidden(filename, buildRoot) {
  const found = new Map();
  for (const occurrence of await forbiddenFileOccurrences(filename, buildRoot)) {
    found.set(occurrence.id, { id: occurrence.id, why: occurrence.why });
  }
  return [...found.values()];
}

/**
 * The SEA executable starts as the exact host Node binary. Node itself embeds
 * sourcemap-parser examples and machine-code byte sequences shaped like AWS
 * keys, so the final scan subtracts only identical baseline occurrences at
 * identical offsets. Any occurrence added by VidCom assets remains forbidden.
 */
export async function finalExecutableForbiddenAdditions(
  artifact,
  baseline = process.execPath,
  buildRoot = REPOSITORY_ROOT,
) {
  const baselineOccurrences = new Set(
    (await forbiddenFileOccurrences(baseline, buildRoot)).map(occurrenceSignature),
  );
  const additions = new Map();
  for (const occurrence of await forbiddenFileOccurrences(artifact, buildRoot)) {
    if (!baselineOccurrences.has(occurrenceSignature(occurrence))) {
      additions.set(occurrence.id, { id: occurrence.id, why: occurrence.why });
    }
  }
  return [...additions.values()];
}

/** Verifies the executable's loader-selected SEA resource is the retained blob. */
export async function verifyInjectedSeaBlob(artifact, blob) {
  try {
    return await verifyActiveSeaResource(artifact, blob);
  } catch (error) {
    fail("final executable active SEA resource differs from the retained blob", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Binds verifier inputs to the child-file digests held by the parent process. */
export async function verifyParentSeaBuildSeal(value, expected, artifact, blob) {
  try {
    return await verifySeaBuildSeal(value, expected, artifact, blob);
  } catch (error) {
    fail("SEA artifact generation differs from its parent-held build seal", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Proves the retained blob embeds the parent-held input projection without executing it. */
export async function verifyEmbeddedSeaInputs(blob, sealedProjection) {
  try {
    return await verifySeaPreparationBlob(blob, sealedProjection);
  } catch (error) {
    fail("the final SEA blob differs from the sealed input generation", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Files a shipped artifact directory may contain, and nothing else. */
export const ARTIFACT_ALLOWLIST = new Set([
  "vidcom",
  "vidcom.exe",
  "SHA256SUMS",
  "artifact-manifest.json",
]);

export function unexpectedEntries(entries) {
  return entries.filter((name) => !ARTIFACT_ALLOWLIST.has(name));
}

async function sha256Of(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * The exact build tools that produced this artifact, checked against their pins.
 *
 * Recording the versions is not enough on its own. A tar that resolved to
 * something other than the declared pin writes archives nobody reviewed, and a
 * postject other than the pinned one edits the executable format differently —
 * both produce an artifact that looks like the release it claims to be. So the
 * declared pin and the installed reality are compared here, and a mismatch
 * fails the build rather than being written down and shipped.
 */
export function buildToolProvenance(options = {}) {
  const declaredTar = options.declaredTar
    ?? JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "packages/adapter/package.json"), "utf8"))
      .dependencies.tar;
  const installedTar = options.installedTar ?? (() => {
    return JSON.parse(readFileSync(requireFromAdapter.resolve("tar/package.json"), "utf8")).version;
  })();
  if (declaredTar !== installedTar) {
    fail("the installed tar is not the one this repository pins", {
      declared: declaredTar,
      installed: installedTar,
    });
  }

  // Pinned by exact version in the build script, and stated the same way here
  // so a floating spec would be visible rather than merely permitted.
  const postject = options.postject ?? POSTJECT;
  if (!/^postject@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(postject)) {
    fail("postject must be pinned to an exact version", { requested: postject });
  }

  const bun = options.bun ?? (() => {
    const result = spawnSync("bun", ["--version"], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  })();
  // Bun has no entry in the lockfile to check against — it is the toolchain
  // itself, not a dependency — so it is recorded rather than compared. Saying
  // which one built the artifact is still worth more than saying nothing.
  return { tar: installedTar, postject: postject.slice("postject@".length), bun };
}

/**
 * Everything a bug report needs to identify this exact build.
 *
 * `dirty` is recorded rather than refused here, and the release job is what
 * insists on `false`: a developer building locally from a modified tree should
 * get an artifact plus an honest label, not a failure.
 */
export async function artifactManifest(tag, artifact, runtimeManifest) {
  const runtimeArchives = Object.fromEntries(hostRuntimeArchives(tag, runtimeManifest).map((archive) => [
    archive.key,
    { sha256: archive.sha256, bytes: archive.bytes },
  ]));
  return {
    version: 1,
    platform: tag,
    commit: gitOutput(["rev-parse", "HEAD"]) ?? "unknown",
    dirty: (gitOutput(["status", "--porcelain"]) ?? "") !== "",
    node: process.version,
    tools: buildToolProvenance(),
    runtime: {
      artifactVersion: runtimeManifest.artifactVersion,
      versions: runtimeManifest.versions,
      archives: runtimeArchives,
    },
    createdAt: new Date().toISOString(),
    files: {
      [path.basename(artifact)]: await sha256Of(artifact),
    },
  };
}

export function formatChecksums(files) {
  // The `sha256sum -c` format, so a user can verify a download with a tool they
  // already have rather than one we ask them to install.
  return `${Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n")}\n`;
}

export async function verifyFrontendPayload(
  manifestFile = MANIFEST_PATH,
  packFile = PACK_PATH,
) {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || Object.keys(manifest).length !== 1
    || !Array.isArray(manifest.entries)
    || manifest.entries.length === 0
  ) fail("frontend manifest must contain one non-empty entries array");
  const pack = await readFile(packFile);
  const paths = new Set();
  let expectedOffset = 0;
  let previousPath;
  for (const [index, entry] of manifest.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("frontend manifest entry must be an object", { index });
    }
    const keys = Object.keys(entry).sort(compareUtf8);
    const expectedKeys = ["cachePolicy", "length", "mime", "offset", "path", "sha256"].sort(compareUtf8);
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      fail("frontend manifest entry has unexpected fields", { index, keys });
    }
    if (
      typeof entry.path !== "string"
      || entry.path.length === 0
      || entry.path.includes("\\")
      || path.posix.isAbsolute(entry.path)
      || path.win32.isAbsolute(entry.path)
      || path.posix.normalize(entry.path) !== entry.path
      || entry.path.split("/").some((part) => part === "" || part === "." || part === "..")
      || paths.has(entry.path)
      || (previousPath !== undefined && compareUtf8(previousPath, entry.path) >= 0)
    ) fail("frontend manifest paths must be unique, portable, and sorted", { index, path: entry.path });
    if (
      FORBIDDEN_RUNTIME_EXTENSION.test(entry.path)
      || entry.path.split("/").some((part) => FORBIDDEN_RUNTIME_DIRECTORY.has(part.toLowerCase()))
    ) fail("frontend payload contains a source, declaration, test, or sourcemap path", { path: entry.path });
    if (
      !Number.isSafeInteger(entry.offset)
      || !Number.isSafeInteger(entry.length)
      || entry.offset !== expectedOffset
      || entry.length < 0
      || entry.offset + entry.length > pack.length
    ) fail("frontend manifest offsets must cover the pack contiguously", { index, path: entry.path });
    if (
      typeof entry.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(entry.sha256)
      || typeof entry.mime !== "string"
      || entry.mime.length === 0
      || !["immutable", "no-store"].includes(entry.cachePolicy)
    ) fail("frontend manifest entry metadata is invalid", { index, path: entry.path });
    const actualHash = createHash("sha256")
      .update(pack.subarray(entry.offset, entry.offset + entry.length))
      .digest("hex");
    if (actualHash !== entry.sha256) {
      fail("frontend pack bytes do not match the manifest", {
        path: entry.path,
        expected: entry.sha256,
        actual: actualHash,
      });
    }
    paths.add(entry.path);
    previousPath = entry.path;
    expectedOffset += entry.length;
  }
  if (expectedOffset !== pack.length) {
    fail("frontend manifest does not account for every pack byte", {
      expectedBytes: expectedOffset,
      actualBytes: pack.length,
    });
  }
  return manifest;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function packageNameFromRuntimePath(parts, offset) {
  const first = parts[offset];
  if (!first) return null;
  if (!first.startsWith("@")) return first;
  const second = parts[offset + 1];
  return second ? `${first}/${second}` : null;
}

export function assertAllowedRuntimeEntry(archiveKey, platform, pathname, allowedMotionPaths = new Set()) {
  const parts = pathname.split("/");
  if (FORBIDDEN_RUNTIME_EXTENSION.test(pathname)) {
    fail("runtime archive contains a source, declaration, or sourcemap file", {
      archive: archiveKey,
      path: pathname,
    });
  }
  if (archiveKey === "hyperframes" && parts[0] === "motion-libraries") {
    if (allowedMotionPaths.has(pathname)) return;
    fail("motion runtime path is outside the pinned product catalogue", { path: pathname });
  }
  const outsideFrozenPython = archiveKey !== "node" || parts[0] !== "python";
  if (outsideFrozenPython && parts.some((part) => FORBIDDEN_RUNTIME_DIRECTORY.has(part.toLowerCase()))) {
    fail("runtime archive contains a source, build, or test directory", {
      archive: archiveKey,
      path: pathname,
    });
  }
  const nativePackages = new Set([
    ...COMMON_NATIVE_PACKAGES,
    ...(PLATFORM_NATIVE_PACKAGES[platform] ?? []),
  ]);
  if (archiveKey === "node") {
    if (parts[0] === "python") return;
    if (pathname === "vieneu/worker.py" || pathname === "cli/boot.cjs") return;
    const executableSuffix = platform === "win32-x64" ? ".exe" : "";
    if ([
      `bin/esbuild${executableSuffix}`,
      `bin/ffmpeg${executableSuffix}`,
      `bin/ffprobe${executableSuffix}`,
    ].includes(pathname)) return;
    if (PRODUCT_MIGRATION_PATHS.includes(pathname)) return;
    if (parts[0] === "node_modules" && nativePackages.has(packageNameFromRuntimePath(parts, 1))) return;
  }
  if (archiveKey === "hyperframes") {
    if ([
      "bin/hyperframe.manifest.json",
      "bin/hyperframe.runtime.iife.js",
      "bin/hyperframes.mjs",
      "package.json",
    ].includes(pathname)) return;
    if (parts[0] === "node_modules" && nativePackages.has(packageNameFromRuntimePath(parts, 1))) return;
  }
  fail("runtime archive path is outside the product allowlist", {
    archive: archiveKey,
    platform,
    path: pathname,
  });
}

async function walkRegularFiles(root) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("runtime stage archive source must be a real directory", { root });
  }
  const files = [];
  const visit = async (directory, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = await lstat(filename);
      if (metadata.isSymbolicLink()) fail("runtime stage contains a symlink", { path: relative });
      if (metadata.isDirectory()) {
        await visit(filename, relative);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) fail("runtime stage contains a hard-linked file", { path: relative });
        files.push({ filename, relative, metadata });
      } else {
        fail("runtime stage contains a special file", { path: relative });
      }
    }
  };
  await visit(root);
  return files;
}

async function assertExactDirectoryEntries(directory, expected, label) {
  const actual = (await readdir(directory)).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} contains unexpected or missing entries`, { expected: wanted, actual });
  }
}

function normalizedTarPath(value) {
  const pathname = value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    !pathname
    || pathname.includes("\\")
    || path.posix.isAbsolute(pathname)
    || path.win32.isAbsolute(pathname)
    || path.posix.normalize(pathname) !== pathname
    || pathname.split("/").some((part) => part === "" || part === "." || part === "..")
  ) fail("runtime tar contains an unsafe path", { path: value });
  return pathname;
}

async function extractVerifiedArchive(archiveFile, entries) {
  const expectedFiles = new Set(entries.map((entry) => entry.path));
  const expectedDirectories = new Set();
  for (const filename of expectedFiles) {
    let parent = path.posix.dirname(filename);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const listed = [];
  const validateEntry = (entry, recordFile = false) => {
    const pathname = normalizedTarPath(entry.path);
    if (entry.type === "File" || entry.type === "OldFile") {
      if (!expectedFiles.has(pathname) || (recordFile && listed.includes(pathname))) {
        fail("runtime tar file set differs from the manifest", { path: pathname });
      }
      if (recordFile) listed.push(pathname);
      return true;
    }
    if (entry.type === "Directory" && expectedDirectories.has(pathname)) return true;
    fail("runtime tar contains a link, special, or undeclared entry", {
      path: pathname,
      type: entry.type,
    });
  };
  await listTar({ file: archiveFile, strict: true, onentry: (entry) => validateEntry(entry, true) });
  const sortedListed = [...listed].sort(compareUtf8);
  const sortedExpected = [...expectedFiles].sort(compareUtf8);
  if (JSON.stringify(sortedListed) !== JSON.stringify(sortedExpected)) {
    fail("runtime tar file set differs from the manifest", {
      expected: sortedExpected,
      actual: sortedListed,
    });
  }

  const extractRoot = await mkdtemp(path.join(tmpdir(), "vidcom-verify-archive-"));
  try {
    await extractTar({
      cwd: extractRoot,
      file: archiveFile,
      strict: true,
      preservePaths: false,
      filter: (_pathname, entry) => validateEntry(entry),
    });
    return { extractRoot, files: await walkRegularFiles(extractRoot) };
  } catch (error) {
    await rm(extractRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertFilesMatchEntries(files, expectedEntries, archiveKey, sourceLabel) {
  const orderedFiles = [...files].sort((left, right) => compareUtf8(left.relative, right.relative));
  const orderedEntries = [...expectedEntries].sort((left, right) => compareUtf8(left.path, right.path));
  const actualPaths = orderedFiles.map((entry) => entry.relative);
  const expectedPaths = orderedEntries.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail(`${sourceLabel} differs from the archived entry set`, {
      key: archiveKey,
      expected: expectedPaths,
      actual: actualPaths,
    });
  }
  let bootHash;
  for (let index = 0; index < orderedFiles.length; index += 1) {
    const file = orderedFiles[index];
    const entry = orderedEntries[index];
    const actualHash = await sha256Of(file.filename);
    const declaredHash = SHA256.exec(entry.sha256)?.[1];
    const actualMode = file.metadata.mode & 0o777;
    // Mode is compared only where the filesystem stores one. Windows reports a
    // fixed 0o666 (or 0o444 when read-only) for every file, so comparing there
    // would reject a correct stage for a permission the platform never had.
    // The manifest keeps the mode because it matters when the archive is
    // extracted on a POSIX machine, and the hash — which is the substantive
    // claim about these bytes — is checked on all three.
    const modeMatches = process.platform === "win32" || actualMode === entry.mode;
    if (actualHash !== declaredHash || !modeMatches) {
      fail(`${sourceLabel} file does not match its manifest entry`, {
        key: archiveKey,
        path: file.relative,
        expectedHash: declaredHash,
        actualHash,
        expectedMode: entry.mode,
        actualMode,
      });
    }
    if (archiveKey === "node" && file.relative === "cli/boot.cjs") bootHash = actualHash;
  }
  return bootHash;
}

export async function verifyRuntimePayload(tag, options = {}) {
  const assetRoot = options.assetRoot ?? runtimeAssetRoot(tag);
  const stageRoot = options.stageRoot ?? runtimeStageRoot(tag);
  const secondaryBundle = options.secondaryBundle ?? BUNDLE_PATH;
  const manifestFile = options.manifestFile ?? path.join(assetRoot, "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const { parseEmbeddedRuntimeManifest, validatePackagedRuntimeManifest } = await tsImport(
    "../packages/adapter/src/runtime/runtime-bootstrap.ts",
    import.meta.url,
  );
  const parsedManifest = parseEmbeddedRuntimeManifest(manifest);
  const separator = tag.lastIndexOf("-");
  if (separator <= 0 || separator === tag.length - 1) {
    fail("runtime platform tag is invalid", { tag });
  }
  validatePackagedRuntimeManifest(
    path.resolve(stageRoot, ".verify-app-data"),
    parsedManifest,
    tag.slice(0, separator),
    tag.slice(separator + 1),
  );
  const { MOTION_LIBRARIES } = await tsImport(
    "../packages/contracts/src/motion-libraries.ts",
    import.meta.url,
  );
  const allowedMotionPaths = motionRuntimePaths(MOTION_LIBRARIES);
  const archives = hostRuntimeArchives(tag, manifest);
  await assertExactDirectoryEntries(assetRoot, [
    "runtime-archives",
    "runtime-manifest.json",
  ], "runtime asset root");
  await assertExactDirectoryEntries(
    path.join(assetRoot, "runtime-archives"),
    archives.map((archive) => `${archive.key}.tar.gz`),
    "runtime archive asset root",
  );
  await assertExactDirectoryEntries(
    stageRoot,
    [".build", ...archives.map((archive) => archive.key)],
    "runtime stage root",
  );
  await assertExactDirectoryEntries(
    path.join(stageRoot, ".build"),
    ["python-packages.txt", "runtime-config.json"],
    "runtime stage build metadata",
  );

  const scanTargets = [{ name: "runtime manifest", file: manifestFile }];
  let packagedBootHash;
  for (const archive of archives) {
    const archiveFile = path.join(assetRoot, "runtime-archives", `${archive.key}.tar.gz`);
    const archiveMetadata = await lstat(archiveFile);
    const declaredArchiveHash = SHA256.exec(archive.sha256)?.[1];
    const actualArchiveHash = await sha256Of(archiveFile);
    if (
      !archiveMetadata.isFile()
      || archiveMetadata.isSymbolicLink()
      || archiveMetadata.nlink !== 1
      || archiveMetadata.size !== archive.bytes
      || actualArchiveHash !== declaredArchiveHash
    ) {
      fail("runtime archive does not match its manifest", {
        key: archive.key,
        expectedBytes: archive.bytes,
        actualBytes: archiveMetadata.size,
        expectedHash: declaredArchiveHash,
        actualHash: actualArchiveHash,
      });
    }
    scanTargets.push({ name: `runtime archive ${archive.key}`, file: archiveFile });

    if (!Array.isArray(archive.entries) || archive.entries.length === 0) {
      fail("runtime archive manifest has no entries", { key: archive.key });
    }
    const expectedEntries = [...archive.entries].sort((left, right) => compareUtf8(left.path, right.path));
    for (const entry of expectedEntries) {
      assertAllowedRuntimeEntry(archive.key, archive.platform, entry.path, allowedMotionPaths);
    }
    const staged = await walkRegularFiles(path.join(stageRoot, archive.key));
    const stageBootHash = await assertFilesMatchEntries(staged, expectedEntries, archive.key, "runtime stage");
    if (stageBootHash) packagedBootHash = stageBootHash;
    const extracted = await extractVerifiedArchive(archiveFile, expectedEntries);
    try {
      const archiveBootHash = await assertFilesMatchEntries(
        extracted.files,
        expectedEntries,
        archive.key,
        "runtime tar",
      );
      if (archiveBootHash && archiveBootHash !== packagedBootHash) {
        fail("runtime tar boot differs from the staged secondary bundle");
      }
    } finally {
      await rm(extracted.extractRoot, { recursive: true, force: true });
    }
    for (const file of staged) {
      scanTargets.push({ name: `runtime stage ${archive.key}/${file.relative}`, file: file.filename });
    }
  }
  if (!packagedBootHash || packagedBootHash !== await sha256Of(secondaryBundle)) {
    fail("the staged boot bundle is missing or differs from the emitted secondary bundle");
  }
  return { manifest, scanTargets };
}

export async function assertNoForbiddenFiles(targets, buildRoot) {
  for (const target of targets) {
    if (!existsSync(target.file)) fail(`${target.name} is missing`, { expected: target.file });
    const found = await scanFileForForbidden(target.file, buildRoot);
    if (found.length > 0) {
      fail(`${target.name} contains something that must not ship`, { found });
    }
  }
}

async function assertNoLooseSources(directory) {
  const entries = await readdir(directory);
  const unexpected = unexpectedEntries(entries);
  if (unexpected.length > 0) {
    // A `.map` or a stray `.ts` beside the executable is the same leak as one
    // embedded in it, and easier to miss.
    fail("the artifact directory holds files that are not part of the release", { unexpected });
  }
}

/** Writes one absent provenance file without following a pre-created link. */
export async function writeNewArtifactFile(filename, generation, contents, assertAuthority = async () => {}) {
  const resolved = path.resolve(filename);
  const relative = path.relative(generation, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    fail("artifact provenance output is outside its generation", { filename: resolved });
  }
  await assertAuthority();
  const handle = await open(resolved, "wx", 0o400);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await lstat(resolved);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || await realpath(resolved) !== resolved
  ) fail("artifact provenance output must be one real file", { filename: resolved });
  await assertAuthority();
}

export async function verifyArtifact(target, options = {}) {
  const tag = assertBuildableTarget(target);
  const generation = options.generation;
  const seal = typeof options.seal === "string"
    ? parseSeaBuildSeal(options.seal)
    : exactSeaBuildSeal(options.seal);
  const generationId = seal.generationId;
  if (seal.tag !== tag || artifactBuildDirectory(tag, undefined, generationId) !== generation) {
    fail("SEA build seal does not belong to this artifact generation");
  }
  const authorityFile = path.join(generation, ARTIFACT_BUILD_AUTHORITY_FILE);
  const authorityMetadata = await lstat(authorityFile);
  if (
    !authorityMetadata.isFile()
    || authorityMetadata.isSymbolicLink()
    || authorityMetadata.nlink !== 1
    || await realpath(authorityFile) !== authorityFile
  ) fail("artifact build authority record must be one real file");
  const authority = restoreArtifactBuildAuthority(await readFile(authorityFile, "utf8"));
  if (authority.tag !== tag || authority.generation !== generation) {
    fail("artifact build authority record does not belong to this generation");
  }
  const assertAuthority = () => revalidateArtifactBuildAuthority(authority);
  await assertAuthority();
  const artifact = artifactBuildPath(tag, process.platform, undefined, generation);
  const directory = path.dirname(artifact);
  const blob = path.join(directory, ".sea-prep.blob");
  // This digest authority lives only in the parent process/argv, so a coherent
  // child-file replacement between build-sea and verification is detected.
  await verifyParentSeaBuildSeal(seal, { tag, generationId }, artifact, blob);
  await assertAuthority();
  if (!existsSync(artifact)) fail("there is no artifact to verify", { expected: artifact });
  if ((await stat(artifact)).size === 0) fail("the artifact is empty", { artifact });

  // The blob's byte table is checked directly against the projection captured
  // by build-sea and held by its parent. No snapshot pathname can redefine the
  // expected main or assets at verification time.
  await verifyEmbeddedSeaInputs(blob, seal.inputs);
  await assertAuthority();
  await verifyInjectedSeaBlob(artifact, blob);
  await assertAuthority();
  await verifyParentSeaBuildSeal(seal, { tag, generationId }, artifact, blob);
  await assertAuthority();

  const snapshotRoot = path.join(directory, ".sea-inputs");
  await assertAuthority();
  const snapshotManifest = JSON.parse(await readFile(
    path.join(snapshotRoot, "runtime", "runtime-manifest.json"),
    "utf8",
  ));
  const assertSnapshotProjection = () => assertSeaInputSnapshot(
    tag,
    snapshotManifest,
    snapshotRoot,
    seal.inputs,
  );
  const snapshot = await assertSnapshotProjection();
  await snapshot.assertAuthority();
  await assertAuthority();
  const runtime = await verifyRuntimePayload(tag, {
    assetRoot: path.join(snapshotRoot, "runtime"),
    manifestFile: snapshot.assets["runtime-manifest.json"],
  });
  await verifyFrontendPayload(
    snapshot.assets["frontend-manifest.json"],
    snapshot.assets["frontend.pack"],
  );
  await assertNoForbiddenFiles([
    { name: "SEA main loader", file: snapshot.main },
    { name: "primary SEA bootstrap", file: snapshot.assets[SEA_PRIMARY_BUNDLE_ASSET] },
    { name: "secondary CLI bundle", file: BUNDLE_PATH },
    { name: "frontend manifest", file: snapshot.assets["frontend-manifest.json"] },
    { name: "frontend pack", file: snapshot.assets["frontend.pack"] },
    ...runtime.scanTargets,
  ], REPOSITORY_ROOT);
  // All path-based semantic checks above are bracketed by the projection held
  // outside this generation. A coherent snapshot-directory replacement cannot
  // make the retained blob and the verifier adopt a new set of bytes together.
  await snapshot.assertAuthority();
  await assertSnapshotProjection();
  const executableAdditions = await finalExecutableForbiddenAdditions(artifact);
  if (executableAdditions.length > 0) {
    fail("final executable contains something that must not ship", { found: executableAdditions });
  }

  const manifest = await artifactManifest(tag, artifact, runtime.manifest);
  if (manifest.files[path.basename(artifact)] !== seal.artifact.sha256.slice("sha256:".length)) {
    fail("artifact provenance differs from the parent-held SEA build seal");
  }
  await assertAuthority();
  // Re-hash immediately before cleanup consumes the retained authority. This
  // also prevents a passive-verification child swap from being published.
  await verifyParentSeaBuildSeal(seal, { tag, generationId }, artifact, blob);
  await assertAuthority();
  await rm(snapshotRoot, { recursive: true });
  await assertAuthority();
  const blobMetadata = await lstat(blob);
  if (
    !blobMetadata.isFile()
    || blobMetadata.isSymbolicLink()
    || blobMetadata.nlink !== 1
    || await realpath(blob) !== blob
  ) fail("SEA blob changed during verification");
  await rm(blob);
  await assertAuthority();
  const finalAuthorityMetadata = await lstat(authorityFile);
  if (
    !finalAuthorityMetadata.isFile()
    || finalAuthorityMetadata.isSymbolicLink()
    || finalAuthorityMetadata.nlink !== 1
    || await realpath(authorityFile) !== authorityFile
  ) fail("artifact build authority record changed during verification");
  await rm(authorityFile);
  await assertAuthority();
  await writeNewArtifactFile(
    path.join(directory, "artifact-manifest.json"),
    generation,
    `${JSON.stringify(manifest, null, 2)}\n`,
    assertAuthority,
  );
  await writeNewArtifactFile(
    path.join(directory, "SHA256SUMS"),
    generation,
    formatChecksums(manifest.files),
    assertAuthority,
  );
  await assertAuthority();

  // Written first, then checked: the two files we just wrote are part of the
  // release, and anything else in there is not.
  await assertNoLooseSources(directory);
  await commitArtifactBuild(tag, undefined, { generation, authority });
  if (!existsSync(artifactPath(tag))) fail("the verified artifact was not published");
  return manifest;
}

/**
 * Refuses a release built from a modified tree.
 *
 * `dirty` is recorded for everyone and refused only here, because the two
 * cases are different: a developer building locally from edits should get an
 * artifact and an honest label, while a release that cannot name the exact
 * commit it came from is not a release at all.
 */
export function assertReleasable(manifest) {
  if (manifest.dirty) {
    fail("a release cannot be built from a modified working tree", { commit: manifest.commit });
  }
  if (manifest.commit === "unknown") {
    fail("a release must name the commit it was built from");
  }
  return manifest;
}

async function main(argv) {
  const flags = argv.filter((value) => value === "--release");
  const positional = argv.filter((value) => value !== "--release");
  if (
    positional.length !== 5
    || positional[1] !== "--generation" || !positional[2]
    || positional[3] !== "--seal" || !positional[4]
  ) {
    fail("usage: verify-artifact <platform-tag> --generation <id> --seal <json> [--release]");
  }
  const manifest = await verifyArtifact(positional[0], {
    generation: artifactBuildDirectory(positional[0], undefined, positional[2]),
    seal: positional[4],
  });
  if (flags.length > 0) assertReleasable(manifest);
  process.stderr.write(
    `verify-artifact: ${manifest.platform} ${manifest.commit}${manifest.dirty ? " (dirty)" : ""}\n`,
  );
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    if (!process.exitCode) {
      process.stderr.write(`verify-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
