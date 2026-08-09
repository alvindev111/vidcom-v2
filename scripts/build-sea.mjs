import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { assertBuildableTarget } from "./build-artifact.mjs";
import {
  ARTIFACT_BUILD_AUTHORITY_FILE,
  artifactBuildPath,
  prepareArtifactBuildAuthority,
  revalidateArtifactBuildAuthority,
  serializeArtifactBuildAuthority,
} from "./artifact-publish.mjs";
import {
  PRIMARY_BUNDLE_PATH,
  REPOSITORY_ROOT,
  SEA_DIRECTORY,
  SEA_MAIN_LOADER_PATH,
  runtimeArchivePath,
  runtimeManifestPath,
} from "./artifact-layout.mjs";
import { MANIFEST_PATH as FRONTEND_MANIFEST_PATH, PACK_PATH } from "./build-frontend-pack.mjs";
import { verifySeaPreparationBlob } from "./sea-blob.mjs";
import {
  SEA_PRODUCT_CODE_PATH,
  createSeaBuildSeal,
  exactSeaInputProjection,
  serializeSeaBuildSeal,
} from "./sea-build-seal.mjs";

const ARCHIVE_KEY = /^[a-z0-9][a-z0-9._-]*$/u;
const SHA256 = /^sha256:([0-9a-f]{64})$/u;
export const PRODUCT_RUNTIME_ARCHIVES = ["hyperframes", "node"];

/**
 * The exact postject the build uses.
 *
 * Pinned rather than floating: it edits the executable format directly, so a
 * version change is a change to the bytes shipped to users. Keep the CLI in
 * the lockfile and run it with the pinned Node executable. Package runners may
 * substitute Bun for a `#!/usr/bin/env node` binary, and postject's Emscripten
 * injector aborts on Linux under that substituted runtime.
 */
export const POSTJECT = "postject@1.0.0-alpha.6";
export const POSTJECT_CLI = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("postject"))),
  "cli.js",
);

/** Node's own sentinel. The runtime looks for this exact fuse to find the blob. */
export const SEA_FUSE = "fce680ab2cc467b6e072b8b5df1996b2";
export const SEA_RESOURCE = "NODE_SEA_BLOB";
export const MACHO_SEGMENT = "NODE_SEA";
export const SEA_INTEGRITY_ARGUMENT = "--vidcom-sea-integrity";
export const SEA_PRIMARY_BUNDLE_ASSET = "__vidcom/primary.cjs";

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-sea: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function run(name, command, args, cwd = REPOSITORY_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.error) fail(`${name} could not start`, { command, cause: result.error.message });
  if (result.status !== 0) fail(`${name} failed`, { exitCode: result.status });
}

export { artifactPath } from "./artifact-publish.mjs";

/**
 * The SEA configuration, stated in full.
 *
 * `useCodeCache` and `useSnapshot` are off deliberately. Both bake in
 * V8-version-specific bytes, and a cache built by one Node and read by another
 * fails at start-up rather than falling back — the artifact embeds its own Node
 * binary, but the build machine's `node` is what writes the blob, so the two
 * are only the same version by convention.
 */
function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function hostRuntimeArchives(tag, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("runtime manifest must be an object");
  }
  if (!Array.isArray(manifest.archives) || manifest.archives.length === 0) {
    fail("runtime manifest must contain at least one archive");
  }
  const keys = new Set();
  const archives = manifest.archives.map((archive, index) => {
    if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
      fail("runtime manifest archive must be an object", { index });
    }
    if (typeof archive.key !== "string" || !ARCHIVE_KEY.test(archive.key) || keys.has(archive.key)) {
      fail("runtime manifest archive key is invalid or duplicated", { index, key: archive.key });
    }
    keys.add(archive.key);
    if (archive.platform !== tag) {
      fail("runtime manifest contains an archive for another host", {
        key: archive.key,
        expected: tag,
        actual: archive.platform,
      });
    }
    if (typeof archive.sha256 !== "string" || !SHA256.test(archive.sha256)) {
      fail("runtime manifest archive hash is invalid", { key: archive.key });
    }
    if (!Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) {
      fail("runtime manifest archive byte count is invalid", { key: archive.key });
    }
    return archive;
  });
  archives.sort((left, right) => compareUtf8(left.key, right.key));
  const actualKeys = archives.map((archive) => archive.key);
  if (JSON.stringify(actualKeys) !== JSON.stringify(PRODUCT_RUNTIME_ARCHIVES)) {
    fail("runtime manifest must contain the exact product archive set", {
      expected: PRODUCT_RUNTIME_ARCHIVES,
      actual: actualKeys,
    });
  }
  return archives;
}

export function assertEmbeddedNodeVersion(manifest, actualVersion = process.version) {
  const declared = manifest?.versions?.node;
  const actual = actualVersion.startsWith("v") ? actualVersion.slice(1) : actualVersion;
  if (typeof declared !== "string" || declared !== actual) {
    fail("runtime manifest Node version does not match the executable being embedded", {
      declared,
      actual,
    });
  }
  return actual;
}

export function runtimeAssets(tag, manifest) {
  const assets = {
    "runtime-manifest.json": runtimeManifestPath(tag),
  };
  for (const archive of hostRuntimeArchives(tag, manifest)) {
    assets[`runtime-archives/${archive.key}.tar.gz`] = runtimeArchivePath(tag, archive.key);
  }
  return assets;
}

export function seaInputPaths(tag, manifest) {
  return {
    main: SEA_MAIN_LOADER_PATH,
    assets: {
      [SEA_PRIMARY_BUNDLE_ASSET]: PRIMARY_BUNDLE_PATH,
      "frontend-manifest.json": FRONTEND_MANIFEST_PATH,
      "frontend.pack": PACK_PATH,
      ...runtimeAssets(tag, manifest),
    },
  };
}

function snapshotRelativePath(key) {
  if (key === "main") return "main-loader.cjs";
  if (key === SEA_PRIMARY_BUNDLE_ASSET) return "primary.cjs";
  if (key === "frontend-manifest.json" || key === "frontend.pack") return `frontend/${key}`;
  return `runtime/${key}`;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

async function openBoundInput(key, filename) {
  const source = path.resolve(filename);
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail("SEA input must be one regular, non-linked file", { key });
  }
  if (await realpath(source) !== source) {
    fail("SEA input must not traverse a symlinked path", { key });
  }
  const handle = await open(source, "r");
  const opened = await handle.stat({ bigint: true });
  if (!sameIdentity(before, opened)) {
    await handle.close();
    fail("SEA input changed while it was being opened", { key });
  }
  return { key, source, before, handle };
}

async function ensureOwnedDirectory(root, directory, assertAuthority) {
  const relative = path.relative(root, directory);
  if (relative === "" || relative === ".") {
    await assertAuthority();
    return;
  }
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    fail("SEA output directory is outside its owned root", { directory });
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await assertAuthority();
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(current) !== current) {
      fail("SEA output directory must be a real contained directory", { directory: current });
    }
    await assertAuthority();
  }
}

async function copyOpenedInput(input, destination, root, assertAuthority, mode = 0o400) {
  const resolvedDestination = path.resolve(destination);
  const relative = path.relative(root, resolvedDestination);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    fail("SEA output file is outside its owned root", { destination: resolvedDestination });
  }
  await assertAuthority();
  await ensureOwnedDirectory(root, path.dirname(resolvedDestination), assertAuthority);
  await assertAuthority();
  const output = await open(resolvedDestination, "wx", mode);
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await input.handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await output.sync();
  } finally {
    await output.close();
  }
  await assertAuthority();
  const after = await input.handle.stat({ bigint: true });
  if (!sameIdentity(input.before, after) || BigInt(position) !== after.size) {
    fail("SEA input changed while its private snapshot was being copied", { key: input.key });
  }
  await chmod(resolvedDestination, mode);
  await assertAuthority();
  return { bytes: position, sha256: `sha256:${digest.digest("hex")}` };
}

/** Copies one bound source into an absent generation file without following links. */
export async function copyBoundRegularFile(
  key,
  source,
  destination,
  root,
  assertAuthority = async () => {},
  mode = 0o400,
) {
  const input = await openBoundInput(key, source);
  try {
    return await copyOpenedInput(input, destination, path.resolve(root), assertAuthority, mode);
  } finally {
    await input.handle.close();
  }
}

function exactSnapshotManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SEA input snapshot manifest is invalid");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["entries", "schemaVersion"])) {
    fail("SEA input snapshot manifest fields are invalid");
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) fail("SEA input snapshot manifest is invalid");
  for (const entry of value.entries) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["bytes", "key", "relative", "sha256"])
      || typeof entry.key !== "string"
      || typeof entry.relative !== "string"
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== "string"
      || !SHA256.test(entry.sha256)
    ) fail("SEA input snapshot entry is invalid");
  }
  return value;
}

function expectedSnapshotEntries(tag, manifest) {
  const inputs = seaInputPaths(tag, manifest);
  return [
    { key: "main", source: inputs.main },
    ...Object.entries(inputs.assets).map(([key, source]) => ({ key, source })),
  ].sort((left, right) => compareUtf8(left.key, right.key));
}

/** Copies one immutable, private generation for every byte the SEA blob builder reads. */
export async function snapshotSeaInputs(tag, manifest, snapshotRoot, options = {}) {
  const root = path.resolve(snapshotRoot);
  const entries = expectedSnapshotEntries(tag, manifest);
  const supplied = options.inputs ?? seaInputPaths(tag, manifest);
  const suppliedEntries = [
    { key: "main", source: supplied.main },
    ...Object.entries(supplied.assets ?? {}).map(([key, source]) => ({ key, source })),
  ].sort((left, right) => compareUtf8(left.key, right.key));
  if (JSON.stringify(suppliedEntries.map(({ key }) => key)) !== JSON.stringify(entries.map(({ key }) => key))) {
    fail("SEA input set differs from the exact product asset set");
  }
  const assertParentAuthority = options.assertAuthority ?? (async () => {});
  await assertParentAuthority();
  if (existsSync(root)) fail("SEA input snapshot root must start absent");
  await mkdir(root, { recursive: false, mode: 0o700 });
  await assertParentAuthority();
  const rootMetadata = await lstat(root, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || await realpath(root) !== root) {
    fail("SEA input snapshot root must be a real directory");
  }
  const rootIdentity = Object.freeze({
    dev: rootMetadata.dev,
    ino: rootMetadata.ino,
    birthtimeNs: rootMetadata.birthtimeNs,
  });
  const assertSnapshotAuthority = async () => {
    await assertParentAuthority();
    const current = await lstat(root, { bigint: true });
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== rootIdentity.dev
      || current.ino !== rootIdentity.ino
      || current.birthtimeNs !== rootIdentity.birthtimeNs
      || await realpath(root) !== root
    ) fail("SEA input snapshot authority changed");
  };
  const opened = [];
  try {
    for (const entry of suppliedEntries) opened.push(await openBoundInput(entry.key, entry.source));
    await options.onBoundary?.("afterInputsOpened");
    const records = [];
    for (const input of opened) {
      const relative = snapshotRelativePath(input.key);
      const projection = await copyOpenedInput(
        input,
        path.join(root, ...relative.split("/")),
        root,
        assertSnapshotAuthority,
      );
      records.push({ key: input.key, relative, ...projection });
    }
    const mainRecord = records.find(({ key }) => key === "main");
    const projection = exactSeaInputProjection({
      codePath: SEA_PRODUCT_CODE_PATH,
      main: mainRecord && { bytes: mainRecord.bytes, sha256: mainRecord.sha256 },
      assets: records
        .filter(({ key }) => key !== "main")
        .map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 })),
    });
    for (const input of opened) {
      const current = await lstat(input.source, { bigint: true });
      if (!sameIdentity(input.before, current) || await realpath(input.source) !== input.source) {
        fail("SEA input changed before the private snapshot was sealed", { key: input.key });
      }
    }
    await assertSnapshotAuthority();
    await writeFile(
      path.join(root, "snapshot-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, entries: records }, null, 2)}\n`,
      { flag: "wx", mode: 0o400 },
    );
    await assertSnapshotAuthority();
    const checked = await assertSeaInputSnapshot(tag, manifest, root, projection);
    await assertSnapshotAuthority();
    return { ...checked, projection, assertAuthority: assertSnapshotAuthority };
  } catch (error) {
    // Cleanup is allowed only while the same parent and snapshot directory
    // capabilities are still live. Following a replacement path here would
    // turn a validation failure into deletion outside the artifact generation.
    try {
      await assertSnapshotAuthority();
      await rm(root, { recursive: true, force: true });
      await assertParentAuthority();
    } catch {
      // Fail closed and leave the orphan for explicit recovery. The original
      // error is the actionable cause; cleanup must never broaden its scope.
    }
    throw error;
  } finally {
    await Promise.allSettled(opened.map((input) => input.handle.close()));
  }
}

/** Revalidates the sealed generation before blob creation, injection, and final verification. */
export async function assertSeaInputSnapshot(tag, manifest, snapshotRoot, sealedProjection) {
  const root = path.resolve(snapshotRoot);
  const rootMetadata = await lstat(root, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || await realpath(root) !== root) {
    fail("SEA input snapshot root must be a real directory");
  }
  const rootIdentity = Object.freeze({
    dev: rootMetadata.dev,
    ino: rootMetadata.ino,
    birthtimeNs: rootMetadata.birthtimeNs,
  });
  const assertAuthority = async () => {
    const current = await lstat(root, { bigint: true });
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== rootIdentity.dev
      || current.ino !== rootIdentity.ino
      || current.birthtimeNs !== rootIdentity.birthtimeNs
      || await realpath(root) !== root
    ) fail("SEA input snapshot authority changed");
  };
  const snapshotManifestFile = path.join(root, "snapshot-manifest.json");
  const snapshotMetadata = await lstat(snapshotManifestFile);
  if (
    !snapshotMetadata.isFile()
    || snapshotMetadata.isSymbolicLink()
    || snapshotMetadata.nlink !== 1
    || await realpath(snapshotManifestFile) !== snapshotManifestFile
  ) fail("SEA input snapshot manifest must be one regular file");
  const snapshot = exactSnapshotManifest(JSON.parse(
    await readFile(snapshotManifestFile, "utf8"),
  ));
  const expected = expectedSnapshotEntries(tag, manifest);
  const records = [...snapshot.entries].sort((left, right) => compareUtf8(left.key, right.key));
  if (JSON.stringify(records.map(({ key, relative }) => ({ key, relative }))) !== JSON.stringify(
    expected.map(({ key }) => ({ key, relative: snapshotRelativePath(key) })),
  )) fail("SEA input snapshot does not contain the exact product asset set");
  const projection = exactSeaInputProjection(sealedProjection);
  const sealedRecords = [
    { key: "main", ...projection.main },
    ...projection.assets,
  ].sort((left, right) => compareUtf8(left.key, right.key));
  if (JSON.stringify(records.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 })))
    !== JSON.stringify(sealedRecords)) {
    fail("SEA input snapshot manifest differs from the parent-held projection");
  }
  /** @type {{
   *   main: string;
   *   assets: Record<string, string> & {
   *     "__vidcom/primary.cjs": string;
   *     "frontend-manifest.json": string;
   *     "frontend.pack": string;
   *     "runtime-manifest.json": string;
   *   };
   * }} */
  const inputs = {
    main: "",
    assets: {
      [SEA_PRIMARY_BUNDLE_ASSET]: "",
      "frontend-manifest.json": "",
      "frontend.pack": "",
      "runtime-manifest.json": "",
    },
  };
  for (const record of records) {
    const filename = path.join(root, ...record.relative.split("/"));
    const metadata = await lstat(filename);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size !== record.bytes
      || await realpath(filename) !== filename
      || `sha256:${await sha256Of(filename)}` !== record.sha256
    ) fail("SEA input snapshot bytes differ from the sealed generation", { key: record.key });
    if (record.key === "main") inputs.main = filename;
    else inputs.assets[record.key] = filename;
  }
  const snapshotManifest = JSON.parse(await readFile(inputs.assets["runtime-manifest.json"], "utf8"));
  if (!isDeepStrictEqual(snapshotManifest, manifest)) {
    fail("SEA runtime manifest changed between validation and snapshot");
  }
  await assertAuthority();
  return { root, ...inputs, projection, assertAuthority };
}

export function seaConfig(
  tag,
  manifest,
  blobPath = path.join(SEA_DIRECTORY, "sea-prep.blob"),
  inputs = seaInputPaths(tag, manifest),
  workingDirectory = REPOSITORY_ROOT,
) {
  // Relative to the working directory the blob step runs in, not to the
  // configuration file that holds them. Getting that backwards fails with
  // "Cannot read main script", which reads like a missing bundle.
  const fromRoot = (target) => path.relative(workingDirectory, target).split(path.sep).join("/");
  return {
    main: fromRoot(inputs.main),
    output: fromRoot(blobPath),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    // The frontend rides along as assets rather than as a directory beside the
    // executable, which is the whole point: one file, nothing to unpack.
    assets: {
      ...Object.fromEntries(Object.entries(inputs.assets).map(([key, value]) => [key, fromRoot(value)])),
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

export function requiredInputs(tag, manifest) {
  return [
    SEA_MAIN_LOADER_PATH,
    PRIMARY_BUNDLE_PATH,
    FRONTEND_MANIFEST_PATH,
    PACK_PATH,
    ...Object.values(runtimeAssets(tag, manifest)),
  ];
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

async function assertOwnedRegularFile(filename, root, assertAuthority) {
  await assertAuthority();
  const resolved = path.resolve(filename);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    fail("SEA output file is outside its artifact generation", { filename: resolved });
  }
  const metadata = await lstat(resolved);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || await realpath(resolved) !== resolved
  ) fail("SEA output must be one real contained file", { filename: resolved });
  await assertAuthority();
  return resolved;
}

async function assertPathAbsent(filename, label) {
  try {
    await lstat(filename);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} must start absent`, { filename });
}

async function sha256Of(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadHostRuntimeManifest(tag) {
  const filename = runtimeManifestPath(tag);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    fail("the host runtime manifest is missing or invalid", {
      manifest: filename,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  hostRuntimeArchives(tag, manifest);
  return manifest;
}

export async function assertRuntimeArchiveHashes(tag, manifest, assets = runtimeAssets(tag, manifest)) {
  for (const archive of hostRuntimeArchives(tag, manifest)) {
    const filename = assets[`runtime-archives/${archive.key}.tar.gz`];
    if (typeof filename !== "string") {
      fail("runtime archive is absent from the SEA input generation", { key: archive.key });
    }
    const metadata = await stat(filename);
    const expectedHash = SHA256.exec(archive.sha256)?.[1];
    const actualHash = await sha256Of(filename);
    if (metadata.size !== archive.bytes || actualHash !== expectedHash) {
      fail("runtime archive bytes do not match the host manifest", {
        key: archive.key,
        expectedBytes: archive.bytes,
        actualBytes: metadata.size,
        expectedHash,
        actualHash,
      });
    }
  }
}

export async function buildSea(target, options = {}) {
  const tag = assertBuildableTarget(target);
  const runtimeManifest = await loadHostRuntimeManifest(tag);
  // This is intentionally before mkdir/config/blob/copy: a mismatched build
  // must not leave an artifact that merely claims to contain another Node.
  assertEmbeddedNodeVersion(runtimeManifest);
  assertInputsPresent(requiredInputs(tag, runtimeManifest));

  const prepared = await prepareArtifactBuildAuthority(tag, undefined, {
    generationId: options.generationId,
  });
  const buildDirectory = prepared.generation;
  const generationPrefix = `${tag}.build-`;
  const generationName = path.basename(buildDirectory);
  const generationId = generationName.startsWith(generationPrefix)
    ? generationName.slice(generationPrefix.length)
    : "";
  const assertBuildAuthority = () => revalidateArtifactBuildAuthority(prepared.authority);
  await options.onBoundary?.("afterBuildPrepared", { buildDirectory });
  await assertBuildAuthority();
  const authorityRecord = path.join(buildDirectory, ARTIFACT_BUILD_AUTHORITY_FILE);
  await writeFile(authorityRecord, serializeArtifactBuildAuthority(prepared.authority), {
    flag: "wx",
    mode: 0o400,
  });
  await assertOwnedRegularFile(authorityRecord, buildDirectory, assertBuildAuthority);
  const snapshotRoot = path.join(buildDirectory, ".sea-inputs");
  const snapshot = await snapshotSeaInputs(tag, runtimeManifest, snapshotRoot, {
    assertAuthority: assertBuildAuthority,
  });
  const assertSnapshotAuthority = async () => {
    await snapshot.assertAuthority();
    const checked = await assertSeaInputSnapshot(
      tag,
      runtimeManifest,
      snapshotRoot,
      snapshot.projection,
    );
    await snapshot.assertAuthority();
    return checked;
  };
  await assertRuntimeArchiveHashes(tag, runtimeManifest, snapshot.assets);
  const configPath = path.join(buildDirectory, ".sea-config.json");
  const blob = path.join(buildDirectory, ".sea-prep.blob");
  await assertBuildAuthority();
  await writeFile(
    configPath,
    `${JSON.stringify(seaConfig(tag, runtimeManifest, blob, snapshot, buildDirectory), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await assertOwnedRegularFile(configPath, buildDirectory, assertBuildAuthority);
  await assertBuildAuthority();
  await assertSnapshotAuthority();
  await assertPathAbsent(blob, "SEA blob output");
  await assertBuildAuthority();
  run("sea blob", process.execPath, ["--experimental-sea-config", configPath], buildDirectory);
  await assertOwnedRegularFile(blob, buildDirectory, assertBuildAuthority);
  await assertBuildAuthority();
  await assertSnapshotAuthority();
  await verifySeaPreparationBlob(blob, snapshot.projection);

  const output = artifactBuildPath(tag, process.platform, undefined, buildDirectory);
  // The Node that runs this build is the Node that ships. There is no
  // cross-build, so taking the running binary is both the simplest source and
  // the only one guaranteed to match the platform being built for.
  await copyBoundRegularFile(
    "node-executable",
    process.execPath,
    output,
    buildDirectory,
    assertBuildAuthority,
    0o700,
  );
  await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);
  chmodSync(output, 0o755);
  await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);

  if (process.platform === "darwin") {
    // The copy carries the original signature, which no longer matches once a
    // segment is injected. Removing it first is what keeps the injection from
    // producing a binary the kernel refuses to start.
    await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);
    run("remove signature", "codesign", ["--remove-signature", output]);
    await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);
  }

  await assertSnapshotAuthority();
  await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);
  await assertOwnedRegularFile(blob, buildDirectory, assertBuildAuthority);
  run("inject blob", process.execPath, [POSTJECT_CLI, ...postjectArguments(output, blob)]);
  await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);
  await assertSnapshotAuthority();

  if (process.platform === "darwin") {
    // An arm64 Mach-O with no valid signature is killed on launch, so this is
    // not a hardening step that can wait: without it the artifact does not run
    // at all on the machine that just built it.
    await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);
    run("ad-hoc sign", "codesign", ["--sign", "-", "--force", output]);
    await assertOwnedRegularFile(output, buildDirectory, assertBuildAuthority);
  }

  await assertOwnedRegularFile(configPath, buildDirectory, assertBuildAuthority);
  await rm(configPath, { force: true });
  await assertBuildAuthority();
  // The verifier process needs these exact bytes to prove the final executable
  // contains the blob produced from this sealed loader/input generation.
  await assertOwnedRegularFile(blob, buildDirectory, assertBuildAuthority);
  const seal = await createSeaBuildSeal(tag, generationId, output, blob, snapshot.projection);
  await assertBuildAuthority();

  return { output, seal };
}

async function main(argv) {
  const target = argv[0];
  if (argv.length !== 3 || argv[1] !== "--generation" || !argv[2]) {
    fail("usage: build-sea <platform-tag> --generation <generation-id>");
  }
  const result = await buildSea(target, { generationId: argv[2] });
  // stdout is a private protocol with the parent orchestrator. All progress,
  // including child-tool stdout, is redirected to stderr above.
  process.stdout.write(serializeSeaBuildSeal(result.seal));
  process.stderr.write(`build-sea: ${result.output}\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    if (!process.exitCode) {
      process.stderr.write(`build-sea: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
