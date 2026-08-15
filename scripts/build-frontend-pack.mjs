import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mimeTypeFor, resolveAsset } from "../packages/cli/src/sea-static-host.ts";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const EXPORT_DIRECTORY = path.join(REPOSITORY_ROOT, "out");
export const PACK_PATH = path.join(REPOSITORY_ROOT, "dist", "sea", "frontend.pack");
export const MANIFEST_PATH = path.join(REPOSITORY_ROOT, "dist", "sea", "frontend-manifest.json");

const PUBLICATION_SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ACTIVE_PUBLICATIONS = new Set();

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-frontend-pack: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

/** Every file the export wrote, as manifest keys, in a stable order. */
export async function exportedFiles(root) {
  const found = [];
  const visit = async (current) => {
    const directory = await lstat(current);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      fail("the static export must contain only real directories and regular files", {
        path: path.relative(root, current) || ".",
      });
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const metadata = await lstat(target);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(target);
      else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        found.push(path.relative(root, target).split(path.sep).join("/"));
      } else {
        // Symlinks can escape the export and special files can block forever.
        // Neither is a self-contained immutable frontend asset.
        fail("the static export must contain only real directories and regular files", {
          path: path.relative(root, target).split(path.sep).join("/"),
        });
      }
    }
  };
  await visit(root);
  // Sorted so two builds of the same export produce byte-identical output.
  return found.sort();
}

/**
 * Describes one asset the way the host will need it.
 *
 * The cache policy is asked of the resolver rather than decided here. The
 * resolver is what answers the browser at runtime, so deriving the manifest
 * from it is what keeps the two from disagreeing — and a disagreement here
 * means an asset is cached forever under a rule the host never applied.
 */
export function describeAsset(assetPath, bytes, offset) {
  const resolution = resolveAsset(`/${assetPath}`);
  if (resolution === null) {
    fail("the export wrote a file the resolver refuses to serve", { path: assetPath });
  }
  return {
    path: assetPath,
    offset,
    length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime: mimeTypeFor(assetPath),
    cachePolicy: resolution.cachePolicy,
  };
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : undefined;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicationPaths(packPath, manifestPath) {
  const pack = path.resolve(packPath);
  const manifest = path.resolve(manifestPath);
  const paths = Object.freeze({
    key: `${pack}\0${manifest}`,
    pack,
    manifest,
    nextPack: `${pack}.next`,
    nextManifest: `${manifest}.next`,
    previousPack: `${pack}.previous`,
    previousManifest: `${manifest}.previous`,
    journal: `${manifest}.publish.json`,
  });
  const transactionPaths = [
    paths.pack,
    paths.manifest,
    paths.nextPack,
    paths.nextManifest,
    paths.previousPack,
    paths.previousManifest,
    paths.journal,
  ];
  if (new Set(transactionPaths).size !== transactionPaths.length) {
    fail("frontend publication paths must be disjoint");
  }
  return paths;
}

function contained(root, candidate) {
  const relation = path.relative(root, candidate);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation));
}

async function ensureRealDirectoryChain(directory, label) {
  const target = path.resolve(directory);
  const filesystemRoot = path.parse(target).root;
  const segments = path.relative(filesystemRoot, target).split(path.sep).filter(Boolean);
  let current = filesystemRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail(`${label} parent chain must contain only real directories`, { path: current });
    }
  }
  return realpath(target);
}

async function assertPublicationAuthority(paths, expectedRoot) {
  const root = path.resolve(expectedRoot ?? path.dirname(paths.pack));
  if (
    paths.pack === root
    || paths.manifest === root
    || !contained(root, paths.pack)
    || !contained(root, paths.manifest)
  ) fail("frontend publication paths escape the expected build root", { root });

  const canonicalRoot = await ensureRealDirectoryChain(root, "frontend build root");
  const [canonicalPackParent, canonicalManifestParent] = await Promise.all([
    ensureRealDirectoryChain(path.dirname(paths.pack), "frontend pack"),
    ensureRealDirectoryChain(path.dirname(paths.manifest), "frontend manifest"),
  ]);
  if (
    !contained(canonicalRoot, canonicalPackParent)
    || !contained(canonicalRoot, canonicalManifestParent)
  ) fail("frontend publication parent resolves outside the expected build root", { root });
  return root;
}

async function optionalFile(filename, label) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular file`, { path: filename });
  }
  return readFile(filename);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function parsePublicationJournal(bytes, paths) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("the frontend publication journal is not valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const expected = [
    "schemaVersion",
    "transactionId",
    "packPath",
    "manifestPath",
    "ownerPid",
    "hadPrevious",
    "previousPackSha256",
    "previousManifestSha256",
    "nextPackSha256",
    "nextManifestSha256",
  ].sort();
  const actual = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const exact = actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
  const previousHashesValid = value?.hadPrevious === true
    ? HASH_PATTERN.test(value.previousPackSha256)
      && HASH_PATTERN.test(value.previousManifestSha256)
    : value?.hadPrevious === false
      ? value.previousPackSha256 === null
        && value.previousManifestSha256 === null
      : false;
  if (
    !exact
    || value.schemaVersion !== PUBLICATION_SCHEMA_VERSION
    || typeof value.transactionId !== "string"
    || !/^[0-9a-f-]{36}$/u.test(value.transactionId)
    || value.packPath !== paths.pack
    || value.manifestPath !== paths.manifest
    || !Number.isSafeInteger(value.ownerPid)
    || value.ownerPid <= 0
    || !previousHashesValid
    || !HASH_PATTERN.test(value.nextPackSha256)
    || !HASH_PATTERN.test(value.nextManifestSha256)
  ) fail("the frontend publication journal does not match its output authority");
  return value;
}

function matches(bytes, expected) {
  return bytes !== null && digest(bytes) === expected;
}

async function removeKnownFile(filename) {
  await rm(filename, { force: true });
}

async function restorePreviousFile(input) {
  if (matches(input.published, input.previousSha256)) {
    if (input.backup !== null) await removeKnownFile(input.backupPath);
    return;
  }
  if (input.published !== null) await removeKnownFile(input.target);
  if (!matches(input.backup, input.previousSha256)) {
    fail("the interrupted frontend publication lost its previous generation", {
      path: input.target,
    });
  }
  await rename(input.backupPath, input.target);
}

/**
 * Recovers an interrupted two-file switch to either its complete previous or
 * complete next generation. A live publisher is never stolen.
 */
export async function recoverFrontendPublication(packPath, manifestPath, options = {}) {
  const paths = publicationPaths(packPath, manifestPath);
  await assertPublicationAuthority(paths, options.outputRoot);
  if (ACTIVE_PUBLICATIONS.has(paths.key) && options.allowActive !== true) {
    fail("the frontend publication is still active in this process");
  }
  const journalBytes = await optionalFile(paths.journal, "frontend publication journal");
  if (journalBytes === null) {
    const transactionFiles = await Promise.all([
      optionalFile(paths.nextPack, "next frontend pack"),
      optionalFile(paths.nextManifest, "next frontend manifest"),
      optionalFile(paths.previousPack, "previous frontend pack"),
      optionalFile(paths.previousManifest, "previous frontend manifest"),
    ]);
    if (transactionFiles.some((bytes) => bytes !== null)) {
      fail("frontend publication has orphaned transaction files");
    }
    const [pack, manifest] = await Promise.all([
      optionalFile(paths.pack, "frontend pack"),
      optionalFile(paths.manifest, "frontend manifest"),
    ]);
    if ((pack === null) !== (manifest === null)) {
      fail("frontend publication is incomplete");
    }
    return;
  }

  const journal = parsePublicationJournal(journalBytes, paths);
  if (
    journal.ownerPid !== process.pid
    && processIsAlive(journal.ownerPid)
  ) fail("another frontend publication is still active", { ownerPid: journal.ownerPid });

  const [publishedPack, publishedManifest, nextPack, nextManifest, previousPack, previousManifest]
    = await Promise.all([
      optionalFile(paths.pack, "frontend pack"),
      optionalFile(paths.manifest, "frontend manifest"),
      optionalFile(paths.nextPack, "next frontend pack"),
      optionalFile(paths.nextManifest, "next frontend manifest"),
      optionalFile(paths.previousPack, "previous frontend pack"),
      optionalFile(paths.previousManifest, "previous frontend manifest"),
    ]);

  for (const [bytes, expected, label] of [
    [nextPack, journal.nextPackSha256, "next frontend pack"],
    [nextManifest, journal.nextManifestSha256, "next frontend manifest"],
    [previousPack, journal.previousPackSha256, "previous frontend pack"],
    [previousManifest, journal.previousManifestSha256, "previous frontend manifest"],
  ]) {
    if (bytes !== null && (typeof expected !== "string" || !matches(bytes, expected))) {
      fail(`${label} does not match the publication journal`);
    }
  }

  const nextIsComplete = matches(publishedPack, journal.nextPackSha256)
    && matches(publishedManifest, journal.nextManifestSha256);
  if (nextIsComplete) {
    await removeKnownFile(paths.nextPack);
    await removeKnownFile(paths.nextManifest);
    await removeKnownFile(paths.previousPack);
    await removeKnownFile(paths.previousManifest);
    await removeKnownFile(paths.journal);
    return;
  }

  for (const [bytes, nextHash, previousHash, label] of [
    [publishedPack, journal.nextPackSha256, journal.previousPackSha256, "frontend pack"],
    [publishedManifest, journal.nextManifestSha256, journal.previousManifestSha256, "frontend manifest"],
  ]) {
    if (
      bytes !== null
      && !matches(bytes, nextHash)
      && (typeof previousHash !== "string" || !matches(bytes, previousHash))
    ) fail(`${label} matches neither publication generation`);
  }

  if (journal.hadPrevious) {
    await restorePreviousFile({
      target: paths.pack,
      backupPath: paths.previousPack,
      published: publishedPack,
      backup: previousPack,
      previousSha256: journal.previousPackSha256,
    });
    await restorePreviousFile({
      target: paths.manifest,
      backupPath: paths.previousManifest,
      published: publishedManifest,
      backup: previousManifest,
      previousSha256: journal.previousManifestSha256,
    });
  } else {
    if (publishedPack !== null) await removeKnownFile(paths.pack);
    if (publishedManifest !== null) await removeKnownFile(paths.manifest);
  }
  await removeKnownFile(paths.nextPack);
  await removeKnownFile(paths.nextManifest);
  await removeKnownFile(paths.previousPack);
  await removeKnownFile(paths.previousManifest);
  await removeKnownFile(paths.journal);
}

async function publishFrontendGeneration(packBytes, manifestBytes, packPath, manifestPath, options) {
  const paths = publicationPaths(packPath, manifestPath);
  const outputRoot = await assertPublicationAuthority(paths, options.outputRoot);
  await recoverFrontendPublication(paths.pack, paths.manifest, { outputRoot });
  if (ACTIVE_PUBLICATIONS.has(paths.key)) fail("the frontend publication is already active");
  ACTIVE_PUBLICATIONS.add(paths.key);
  try {
    const [previousPack, previousManifest] = await Promise.all([
      optionalFile(paths.pack, "frontend pack"),
      optionalFile(paths.manifest, "frontend manifest"),
    ]);
    const hadPrevious = previousPack !== null && previousManifest !== null;
    if ((previousPack === null) !== (previousManifest === null)) {
      fail("frontend publication is incomplete");
    }
    await writeFile(paths.journal, `${JSON.stringify({
      schemaVersion: PUBLICATION_SCHEMA_VERSION,
      transactionId: randomUUID(),
      packPath: paths.pack,
      manifestPath: paths.manifest,
      ownerPid: process.pid,
      hadPrevious,
      previousPackSha256: previousPack === null ? null : digest(previousPack),
      previousManifestSha256: previousManifest === null ? null : digest(previousManifest),
      nextPackSha256: digest(packBytes),
      nextManifestSha256: digest(manifestBytes),
    })}\n`, { flag: "wx", mode: 0o600, flush: true });
    await writeFile(paths.nextPack, packBytes, { flag: "wx", mode: 0o600, flush: true });
    await writeFile(paths.nextManifest, manifestBytes, { flag: "wx", mode: 0o600, flush: true });

    if (hadPrevious) {
      await rename(paths.pack, paths.previousPack);
      await rename(paths.manifest, paths.previousManifest);
    }
    await rename(paths.nextPack, paths.pack);
    await options.afterPackPublished?.();
    await rename(paths.nextManifest, paths.manifest);
    await options.afterManifestPublished?.();
    await recoverFrontendPublication(paths.pack, paths.manifest, { allowActive: true, outputRoot });
  } catch (error) {
    try {
      await recoverFrontendPublication(paths.pack, paths.manifest, { allowActive: true, outputRoot });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "frontend publication failed and requires recovery",
      );
    }
    throw error;
  } finally {
    ACTIVE_PUBLICATIONS.delete(paths.key);
  }
}

/**
 * Concatenates the export into one pack plus a manifest of offsets.
 *
 * Raw bytes, not base64: the pack is read straight out of the executable as an
 * immutable view, and base64 would cost a third more space in the binary and a
 * decode of the whole frontend before the first byte is served.
 */
export async function buildFrontendPack(
  exportDirectory = EXPORT_DIRECTORY,
  packPath = PACK_PATH,
  manifestPath = MANIFEST_PATH,
  options = {},
) {
  let names;
  try {
    names = await exportedFiles(exportDirectory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return fail("the static export has not been built yet", {
      expected: exportDirectory,
      cause: error instanceof Error ? error.message : String(error),
      hint: "run the static export first; build:artifact does this for you",
    });
  }
  if (names.length === 0) fail("the static export is empty", { directory: exportDirectory });

  const chunks = [];
  const entries = [];
  let offset = 0;
  for (const name of names) {
    const bytes = await readFile(path.join(exportDirectory, name));
    entries.push(describeAsset(name, bytes, offset));
    chunks.push(bytes);
    offset += bytes.length;
  }

  const pack = Buffer.concat(chunks);
  const manifest = Buffer.from(`${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  await publishFrontendGeneration(pack, manifest, packPath, manifestPath, options);
  return { entries, bytes: offset };
}

async function main() {
  const { entries, bytes } = await buildFrontendPack();
  process.stderr.write(`build-frontend-pack: ${entries.length} assets, ${bytes} bytes\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main().catch(reportFrontendPackFailure);
}

/**
 * Converts even an unclassified raw filesystem rejection into a failing CLI.
 *
 * @param {unknown} error
 * @param {{ write(chunk: string): unknown }} [stderr]
 */
export function reportFrontendPackFailure(error, stderr = process.stderr) {
  if (!process.exitCode) {
    stderr.write(`build-frontend-pack: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
