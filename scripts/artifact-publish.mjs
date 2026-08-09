import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { REPOSITORY_ROOT } from "./artifact-layout.mjs";
import {
  commitDirectoryGeneration,
  recoverDirectoryGeneration,
} from "./directory-generation-publish.mjs";

const ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, "dist", "artifact");
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;
export const ARTIFACT_BUILD_AUTHORITY_FILE = ".artifact-build-authority.json";
const DECIMAL_IDENTITY = /^\d+$/u;
const MAX_AUTHORITY_RECORD_BYTES = 64 * 1024;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function artifactTag(tag) {
  if (typeof tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(tag)) {
    throw new Error("artifact tag must be a portable non-empty token");
  }
  return tag;
}

function absoluteArtifactRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root) {
    throw new Error("artifact output root must be a normalized absolute path");
  }
  if (path.dirname(root) === root) throw new Error("artifact output root cannot be a filesystem root");
  return root;
}

function directoryIdentity(filename, metadata) {
  return Object.freeze({
    path: filename,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    mode: Number(metadata.mode & 0o777n),
  });
}

function exactDirectoryIdentity(value, expectedPath, label) {
  const identity = exactKeys(value, ["device", "inode", "mode", "path"], label);
  if (
    identity.path !== expectedPath
    || typeof identity.device !== "string"
    || !DECIMAL_IDENTITY.test(identity.device)
    || typeof identity.inode !== "string"
    || !DECIMAL_IDENTITY.test(identity.inode)
    || !Number.isSafeInteger(identity.mode)
    || identity.mode < 0
    || identity.mode > 0o777
  ) throw new Error(`${label} is invalid`);
  return Object.freeze({
    path: identity.path,
    device: identity.device,
    inode: identity.inode,
    mode: identity.mode,
  });
}

async function captureRealDirectory(filename, label) {
  const metadata = await lstat(filename, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real non-symlink directory`);
  }
  const canonical = await realpath(filename);
  if (path.resolve(canonical) !== filename) {
    throw new Error(`${label} must not traverse a symlink or junction`);
  }
  return directoryIdentity(filename, metadata);
}

function sameDirectoryIdentity(left, right) {
  return left.path === right.path
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode;
}

async function captureArtifactRootAuthority(root, create) {
  const target = absoluteArtifactRoot(root);
  const expectedPaths = artifactRootChainPaths(target);
  const chain = [];
  for (const current of expectedPaths) {
    if (!existsSync(current)) {
      if (!create) throw new Error(`artifact output ancestor is missing: ${current}`);
      try {
        await mkdir(current, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      }
    }
    chain.push(await captureRealDirectory(current, "artifact output ancestor"));
  }
  return Object.freeze({
    schemaVersion: 1,
    root: target,
    chain: Object.freeze(chain),
  });
}

function artifactRootChainPaths(root) {
  const parsed = path.parse(root);
  const paths = [parsed.root];
  let current = parsed.root;
  for (const segment of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  return paths;
}

function exactArtifactRootAuthority(value, expectedRoot) {
  const authority = exactKeys(value, ["chain", "root", "schemaVersion"], "artifact root authority");
  const root = absoluteArtifactRoot(authority.root);
  if (authority.schemaVersion !== 1 || (expectedRoot !== undefined && root !== expectedRoot)) {
    throw new Error("artifact root authority is invalid");
  }
  if (!Array.isArray(authority.chain)) throw new Error("artifact root authority chain is invalid");
  const expectedPaths = artifactRootChainPaths(root);
  if (authority.chain.length !== expectedPaths.length) {
    throw new Error("artifact root authority chain is invalid");
  }
  const chain = authority.chain.map((identity, index) => exactDirectoryIdentity(
    identity,
    expectedPaths[index],
    `artifact root authority chain[${index}]`,
  ));
  return Object.freeze({ schemaVersion: 1, root, chain: Object.freeze(chain) });
}

async function revalidateArtifactRootAuthority(authority) {
  const exact = exactArtifactRootAuthority(authority);
  for (const expected of exact.chain) {
    const actual = await captureRealDirectory(expected.path, "artifact output ancestor");
    if (!sameDirectoryIdentity(expected, actual)) {
      throw new Error(`artifact output authority changed: ${expected.path}`);
    }
  }
  return exact.root;
}

function ownsArtifactGeneration(tag, root, generation) {
  if (typeof generation !== "string" || !path.isAbsolute(generation) || path.dirname(generation) !== root) {
    return false;
  }
  const prefix = `${artifactTag(tag)}.build-`;
  const basename = path.basename(generation);
  return basename.startsWith(prefix) && GENERATION_ID.test(basename.slice(prefix.length));
}

function executableName(platform = process.platform) {
  return platform === "win32" ? "vidcom.exe" : "vidcom";
}

export function artifactDirectory(tag, root = ARTIFACT_ROOT) {
  return path.join(root, artifactTag(tag));
}

export function createArtifactGenerationId() {
  return `${process.pid}-${randomUUID()}`;
}

export function artifactBuildDirectory(tag, root = ARTIFACT_ROOT, generationId) {
  if (typeof generationId !== "string" || !GENERATION_ID.test(generationId)) {
    throw new Error("artifact generation id must be a portable non-empty token");
  }
  return `${artifactDirectory(tag, root)}.build-${generationId}`;
}

export function artifactBackupDirectory(tag, root = ARTIFACT_ROOT) {
  return path.join(root, `.previous-${tag}`);
}

export function artifactPath(tag, platform = process.platform, root = ARTIFACT_ROOT) {
  return path.join(artifactDirectory(tag, root), executableName(platform));
}

export function artifactBuildPath(tag, platform = process.platform, root = ARTIFACT_ROOT, generation) {
  const outputRoot = absoluteArtifactRoot(root);
  if (!ownsArtifactGeneration(tag, outputRoot, generation)) {
    throw new Error("artifact build generation is outside its owned namespace");
  }
  return path.join(generation, executableName(platform));
}

async function assertRealDirectoryIfPresent(directory, label) {
  if (!existsSync(directory)) return;
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function exactArtifactBuildAuthority(value) {
  const authority = exactKeys(
    value,
    ["generation", "generationIdentity", "root", "rootAuthority", "schemaVersion", "tag"],
    "artifact build authority",
  );
  const tag = artifactTag(authority.tag);
  const root = absoluteArtifactRoot(authority.root);
  if (authority.schemaVersion !== 1 || !ownsArtifactGeneration(tag, root, authority.generation)) {
    throw new Error("artifact build authority is invalid");
  }
  const rootAuthority = exactArtifactRootAuthority(authority.rootAuthority, root);
  const generationIdentity = exactDirectoryIdentity(
    authority.generationIdentity,
    authority.generation,
    "artifact build generation identity",
  );
  return Object.freeze({
    schemaVersion: 1,
    tag,
    root,
    generation: authority.generation,
    rootAuthority,
    generationIdentity,
  });
}

async function captureArtifactBuildAuthorityWithRoot(tag, root, generation, originalRootAuthority) {
  const rootAuthority = exactArtifactRootAuthority(originalRootAuthority, root);
  await revalidateArtifactRootAuthority(rootAuthority);
  const generationIdentity = await captureRealDirectory(generation, "artifact build generation");
  await revalidateArtifactRootAuthority(rootAuthority);
  const confirmedGeneration = await captureRealDirectory(generation, "artifact build generation");
  if (!sameDirectoryIdentity(generationIdentity, confirmedGeneration)) {
    throw new Error("artifact build generation identity changed while it was captured");
  }
  return exactArtifactBuildAuthority({
    schemaVersion: 1,
    tag,
    root,
    generation,
    rootAuthority,
    generationIdentity,
  });
}

/** Captures the root capability and build-directory inode before SEA mutates it. */
export async function captureArtifactBuildAuthority(tag, root = ARTIFACT_ROOT, generation) {
  const outputRoot = absoluteArtifactRoot(root);
  if (!ownsArtifactGeneration(tag, outputRoot, generation)) {
    throw new Error("artifact build generation is outside its owned namespace");
  }
  const rootAuthority = await captureArtifactRootAuthority(outputRoot, false);
  return captureArtifactBuildAuthorityWithRoot(tag, outputRoot, generation, rootAuthority);
}

/** Produces the only JSON record accepted by a later verifier process. */
export function serializeArtifactBuildAuthority(authority) {
  return `${JSON.stringify(exactArtifactBuildAuthority(authority))}\n`;
}

/** Restores an exact, non-secret build capability created by another process. */
export function restoreArtifactBuildAuthority(record) {
  if (
    typeof record !== "string"
    || Buffer.byteLength(record, "utf8") === 0
    || Buffer.byteLength(record, "utf8") > MAX_AUTHORITY_RECORD_BYTES
  ) throw new Error("artifact build authority record is invalid");
  let value;
  try {
    value = JSON.parse(record);
  } catch {
    throw new Error("artifact build authority record is invalid");
  }
  return exactArtifactBuildAuthority(value);
}

/** Revalidates the capability without following a replacement directory. */
export async function revalidateArtifactBuildAuthority(authority) {
  const exact = exactArtifactBuildAuthority(authority);
  await revalidateArtifactRootAuthority(exact.rootAuthority);
  const actual = await captureRealDirectory(exact.generation, "artifact build generation");
  if (!sameDirectoryIdentity(exact.generationIdentity, actual)) {
    throw new Error("artifact build generation identity changed");
  }
  await revalidateArtifactRootAuthority(exact.rootAuthority);
  return exact.generation;
}

function rootAuthorityAssertion(rootAuthority) {
  return () => revalidateArtifactRootAuthority(rootAuthority);
}

function buildAuthorityAssertion(authority) {
  return (stage) => stage === "beforeRecoveryMutation" || stage === "beforeLockReleaseMutation"
    ? revalidateArtifactRootAuthority(authority.rootAuthority)
    : revalidateArtifactBuildAuthority(authority);
}

/** Recovers either side of the two-rename directory publish protocol. */
export async function recoverArtifactPublish(tag, root = ARTIFACT_ROOT) {
  const outputRoot = absoluteArtifactRoot(root);
  const rootAuthority = await captureArtifactRootAuthority(outputRoot, true);
  return recoverDirectoryGeneration({
    kind: "artifact",
    published: artifactDirectory(tag, outputRoot),
    backup: artifactBackupDirectory(tag, outputRoot),
    authorityFile: "artifact-manifest.json",
    assertAuthority: rootAuthorityAssertion(rootAuthority),
  });
}

/** Creates one unique generation and captures its capability before returning. */
export async function prepareArtifactBuildAuthority(tag, root = ARTIFACT_ROOT, options = {}) {
  const outputRoot = absoluteArtifactRoot(root);
  const rootAuthority = await captureArtifactRootAuthority(outputRoot, true);
  await recoverDirectoryGeneration({
    kind: "artifact",
    published: artifactDirectory(tag, outputRoot),
    backup: artifactBackupDirectory(tag, outputRoot),
    authorityFile: "artifact-manifest.json",
    assertAuthority: rootAuthorityAssertion(rootAuthority),
  });
  const generationId = options.generationId ?? createArtifactGenerationId();
  const build = artifactBuildDirectory(tag, outputRoot, generationId);
  await revalidateArtifactRootAuthority(rootAuthority);
  await options.onBoundary?.("afterRootValidation");
  await revalidateArtifactRootAuthority(rootAuthority);
  await assertRealDirectoryIfPresent(build, "artifact build generation");
  if (existsSync(build)) throw new Error("artifact build generation already exists");
  await mkdir(build, { recursive: false });
  const authority = await captureArtifactBuildAuthorityWithRoot(
    tag,
    outputRoot,
    build,
    rootAuthority,
  );
  return Object.freeze({ generation: build, authority });
}

/** Compatibility wrapper for callers that do not perform external mutation. */
export async function prepareArtifactBuild(tag, root = ARTIFACT_ROOT, options = {}) {
  const prepared = await prepareArtifactBuildAuthority(tag, root, options);
  return prepared.generation;
}

/** Publishes executable + provenance together; prior complete output survives failure. */
export async function commitArtifactBuild(tag, root = ARTIFACT_ROOT, options = {}) {
  const outputRoot = absoluteArtifactRoot(root);
  const build = options.generation;
  if (!ownsArtifactGeneration(tag, outputRoot, build)) {
    throw new Error("artifact build generation is outside its owned namespace");
  }
  await assertRealDirectoryIfPresent(build, "artifact build generation");
  if (!existsSync(build)) throw new Error("artifact build generation is missing");
  const authority = options.authority
    ?? await captureArtifactBuildAuthority(tag, outputRoot, build);
  const exactAuthority = exactArtifactBuildAuthority(authority);
  if (exactAuthority.tag !== tag || exactAuthority.root !== outputRoot || exactAuthority.generation !== build) {
    throw new Error("artifact build authority does not belong to this generation");
  }
  await revalidateArtifactBuildAuthority(exactAuthority);
  return commitDirectoryGeneration({
    kind: "artifact",
    published: artifactDirectory(tag, outputRoot),
    backup: artifactBackupDirectory(tag, outputRoot),
    generation: build,
    authorityFile: "artifact-manifest.json",
    onBoundary: options.onBoundary,
    assertAuthority: buildAuthorityAssertion(exactAuthority),
  });
}
