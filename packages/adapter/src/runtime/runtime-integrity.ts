import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseRuntimeReadyMarker,
  type PublishedRuntimeInstallation,
} from "./runtime-asset-manager";
import {
  resolveRuntimeArchiveRoots,
  resolveRuntimeArchives,
  type EmbeddedArchive,
  type EmbeddedRuntimeEntry,
} from "./runtime-asset-source";

/** Stable failure categories emitted by the read-only runtime payload verifier. */
export type RuntimeIntegrityFailureReason =
  | "archive_root_invalid"
  | "checksum_mismatch"
  | "hard_link"
  | "missing"
  | "mode_mismatch"
  | "ready_marker_invalid"
  | "special_file"
  | "symlink"
  | "unexpected_directory"
  | "unexpected_file";

/** One relative, non-secret reason an installed runtime failed deep verification. */
export interface RuntimeIntegrityIssue {
  archiveKey: string;
  path: string;
  reason: RuntimeIntegrityFailureReason;
  expected?: string;
  actual?: string;
}

/** Result of hashing and structurally validating every host runtime manifest entry. */
export type RuntimeIntegrityInspection =
  | { ok: true; archives: number; files: number }
  | { ok: false; issue: RuntimeIntegrityIssue };

type RuntimeIntegrityFailure = Extract<RuntimeIntegrityInspection, { ok: false }>;

function issue(
  archiveKey: string,
  pathname: string,
  reason: RuntimeIntegrityFailureReason,
  expected?: string,
  actual?: string,
): RuntimeIntegrityFailure {
  return {
    ok: false,
    issue: {
      archiveKey,
      path: pathname,
      reason,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
    },
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function isRealDirectory(pathname: string): Promise<boolean> {
  try {
    const metadata = await lstat(pathname);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP") || hasCode(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function isRealContainedDirectory(versionRoot: string, target: string): Promise<boolean> {
  if (!isContained(versionRoot, target)) return false;
  let current = versionRoot;
  for (const segment of path.relative(versionRoot, target).split(path.sep).filter(Boolean)) {
    if (!await isRealDirectory(current)) return false;
    current = path.join(current, segment);
  }
  if (!await isRealDirectory(current)) return false;
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(versionRoot),
      realpath(target),
    ]);
    return isContained(canonicalRoot, canonicalTarget);
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP") || hasCode(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

function parentDirectories(entryPath: string): string[] {
  const directories: string[] = [];
  let current = path.posix.dirname(entryPath);
  while (current !== ".") {
    directories.push(current);
    current = path.posix.dirname(current);
  }
  return directories;
}

async function digestFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function readyMarkerName(archive: EmbeddedArchive): string {
  return `.ready-${archive.sha256.slice("sha256:".length)}`;
}

async function verifyReadyMarker(
  installation: PublishedRuntimeInstallation,
  archive: EmbeddedArchive,
  root: string,
): Promise<RuntimeIntegrityFailure | null> {
  const markerName = readyMarkerName(archive);
  const markerPath = path.join(root, markerName);
  let metadata;
  try {
    metadata = await lstat(markerPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return issue(archive.key, markerName, "missing");
    throw error;
  }
  if (metadata.isSymbolicLink()) return issue(archive.key, markerName, "symlink");
  if (!metadata.isFile()) return issue(archive.key, markerName, "special_file");
  if (metadata.nlink !== 1) return issue(archive.key, markerName, "hard_link");
  try {
    const marker = parseRuntimeReadyMarker(JSON.parse(await readFile(markerPath, "utf8")) as unknown);
    if (
      !marker
      || marker.artifactVersion !== installation.manifest.artifactVersion
      || marker.archiveKey !== archive.key
      || marker.archiveSha256 !== archive.sha256
    ) return issue(archive.key, markerName, "ready_marker_invalid");
  } catch (error) {
    if (error instanceof SyntaxError) return issue(archive.key, markerName, "ready_marker_invalid");
    throw error;
  }
  return null;
}

async function verifyArchiveTree(
  installation: PublishedRuntimeInstallation,
  archive: EmbeddedArchive,
  root: string,
  platform: NodeJS.Platform,
): Promise<RuntimeIntegrityFailure | { ok: true; files: number }> {
  if (!await isRealContainedDirectory(installation.versionRoot, root)) {
    return issue(archive.key, ".", "archive_root_invalid");
  }
  const markerFailure = await verifyReadyMarker(installation, archive, root);
  if (markerFailure !== null) return markerFailure;

  const expectedFiles = new Map<string, EmbeddedRuntimeEntry>(
    archive.entries.map((entry) => [entry.path, entry]),
  );
  const expectedDirectories = new Set(archive.entries.flatMap((entry) => parentDirectories(entry.path)));
  const observedFiles = new Set<string>();
  const markerName = readyMarkerName(archive);

  const visit = async (
    directory: string,
    relativeDirectory = "",
  ): Promise<RuntimeIntegrityFailure | null> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) return issue(archive.key, relative, "symlink");
      if (metadata.isDirectory()) {
        if (!expectedDirectories.has(relative)) {
          return issue(archive.key, relative, "unexpected_directory");
        }
        const nested = await visit(absolute, relative);
        if (nested !== null) return nested;
        continue;
      }
      if (!metadata.isFile()) return issue(archive.key, relative, "special_file");
      if (metadata.nlink !== 1) return issue(archive.key, relative, "hard_link");
      if (relative === markerName) continue;
      const expected = expectedFiles.get(relative);
      if (expected === undefined) return issue(archive.key, relative, "unexpected_file");
      observedFiles.add(relative);
      const actualHash = await digestFile(absolute);
      if (actualHash !== expected.sha256) {
        return issue(archive.key, relative, "checksum_mismatch", expected.sha256, actualHash);
      }
      if (platform !== "win32") {
        const actualMode = metadata.mode & 0o777;
        if (actualMode !== expected.mode) {
          return issue(
            archive.key,
            relative,
            "mode_mismatch",
            expected.mode.toString(8).padStart(3, "0"),
            actualMode.toString(8).padStart(3, "0"),
          );
        }
      }
    }
    return null;
  };

  const traversalFailure = await visit(root);
  if (traversalFailure !== null) return traversalFailure;
  const missing = archive.entries.find((entry) => !observedFiles.has(entry.path));
  return missing === undefined
    ? { ok: true, files: observedFiles.size }
    : issue(archive.key, missing.path, "missing");
}

/**
 * Deeply verifies the selected runtime payload without mutating or repairing it.
 *
 * Every host manifest entry must be a regular, single-link file with its exact
 * digest and, on POSIX, mode. Derived directories are the only directories
 * allowed, and the archive's exact ready marker is the only non-manifest file.
 * The first relative issue is returned so doctor never leaks an app-data path.
 */
export async function inspectPublishedRuntimeIntegrity(
  installation: PublishedRuntimeInstallation,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArchitecture: NodeJS.Architecture = process.arch,
): Promise<RuntimeIntegrityInspection> {
  const archives = resolveRuntimeArchives(
    installation.manifest,
    hostPlatform,
    hostArchitecture,
  );
  const expectedRoots = resolveRuntimeArchiveRoots(archives, installation.versionRoot);
  let files = 0;
  for (const archive of archives) {
    const expectedRoot = expectedRoots[archive.key];
    if (expectedRoot === undefined || installation.archiveRoots[archive.key] !== expectedRoot) {
      return issue(archive.key, ".", "archive_root_invalid");
    }
    const inspected = await verifyArchiveTree(installation, archive, expectedRoot, hostPlatform);
    if (!inspected.ok) return inspected;
    files += inspected.files;
  }
  return { ok: true, archives: archives.length, files };
}
