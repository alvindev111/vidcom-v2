import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { ErrorCode } from "@vidcom/contracts";
import { extract, list, type Parser, type ReadEntry } from "tar";

import {
  secureAppDataDirectorySync,
  type SyncCredentialCommandRunner,
} from "../fs/credential-store";
import {
  RuntimeAssetError,
  type EmbeddedArchive,
} from "./runtime-asset-source";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_EXPANSION_RATIO = 20;
const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;

export interface ExtractRuntimeArchiveInput {
  bytes: Uint8Array;
  archive: EmbeddedArchive;
  destination: string;
  platform?: NodeJS.Platform;
  aclRunner?: SyncCredentialCommandRunner;
  hooks?: RuntimeArchiveExtractionHooks;
}

export interface ExtractedRuntimeArchive {
  files: number;
  bytes: number;
}

/** Test seam at the crash boundary between tar writes and tree validation. */
export interface RuntimeArchiveExtractionHooks {
  afterExtract?(): Promise<void>;
}

function rejectArchive(message: string, details?: Record<string, unknown>): never {
  throw new RuntimeAssetError(ErrorCode.RuntimeManifestInvalid, message, details);
}

function incomplete(message: string, details?: Record<string, unknown>): RuntimeAssetError {
  return new RuntimeAssetError(ErrorCode.RuntimeExtractionIncomplete, message, details);
}

function archiveBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function archiveExpansionLimit(archiveBytes: number): number {
  return Math.min(
    MAX_UNPACKED_BYTES,
    Math.max(1024 * 1024, archiveBytes * MAX_EXPANSION_RATIO),
  );
}

function consumeTar(stream: Parser, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    stream.once("end", onEnd);
    stream.once("error", onError);
    try {
      stream.end(bytes);
    } catch (error) {
      onError(error);
    }
  });
}

async function digestFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function canonicalArchivePath(raw: string, kind: "file" | "directory"): string {
  const pathname = kind === "directory" ? raw.replace(/\/+$/u, "") : raw;
  if (
    pathname.length === 0
    || pathname.includes("\\")
    || (kind === "file" && raw.endsWith("/"))
    || path.posix.isAbsolute(pathname)
    || path.win32.isAbsolute(pathname)
    || path.posix.normalize(pathname) !== pathname
    || pathname.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return rejectArchive("runtime archive contains an unsafe path", { path: raw });
  }
  return pathname;
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

async function inspectArchive(bytes: Uint8Array, archive: EmbeddedArchive): Promise<{
  directories: ReadonlySet<string>;
  unpackedBytes: number;
}> {
  if (bytes.byteLength !== archive.bytes) {
    rejectArchive("runtime archive byte length does not match its manifest", {
      archive: archive.key,
      expected: archive.bytes,
      actual: bytes.byteLength,
    });
  }
  const actualHash = digest(bytes);
  if (!HASH_PATTERN.test(archive.sha256) || actualHash !== archive.sha256) {
    rejectArchive("runtime archive checksum does not match its manifest", {
      archive: archive.key,
      expected: archive.sha256,
      actual: actualHash,
    });
  }

  const expectedFiles = new Set(archive.entries.map((entry) => entry.path));
  const allowedDirectories = new Set(archive.entries.flatMap((entry) => parentDirectories(entry.path)));
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const expansionLimit = archiveExpansionLimit(archive.bytes);
  let unpackedBytes = 0;
  const onReadEntry = (entry: ReadEntry): void => {
    if (entry.type !== "File" && entry.type !== "Directory") {
      rejectArchive("runtime archive contains a link or special file", {
        archive: archive.key,
        path: entry.path,
        type: entry.type,
      });
    }
    const kind = entry.type === "File" ? "file" : "directory";
    const entryPath = canonicalArchivePath(entry.path, kind);
    if (kind === "file") {
      if (!expectedFiles.has(entryPath) || seenFiles.has(entryPath)) {
        rejectArchive("runtime archive file is absent from the manifest or duplicated", {
          archive: archive.key,
          path: entryPath,
        });
      }
      seenFiles.add(entryPath);
      unpackedBytes += entry.size;
      if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes > expansionLimit) {
        rejectArchive("runtime archive exceeds the allowed expansion bound", {
          archive: archive.key,
          unpackedBytes,
          expansionLimit,
        });
      }
    } else if (!allowedDirectories.has(entryPath) || seenDirectories.has(entryPath)) {
      rejectArchive("runtime archive directory is absent from the derived allowlist or duplicated", {
        archive: archive.key,
        path: entryPath,
      });
    } else {
      seenDirectories.add(entryPath);
    }
  };

  const parser = list({
    strict: true,
    maxDecompressionRatio: expansionLimit / archive.bytes,
    onReadEntry,
  });
  try {
    await consumeTar(parser, archiveBuffer(bytes));
  } catch (error) {
    if (error instanceof RuntimeAssetError) throw error;
    rejectArchive("runtime archive header validation failed", {
      archive: archive.key,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const missing = [...expectedFiles].filter((entryPath) => !seenFiles.has(entryPath));
  if (missing.length > 0) {
    rejectArchive("runtime archive is missing manifest entries", { archive: archive.key, missing });
  }
  return { directories: allowedDirectories, unpackedBytes };
}

async function verifyExtractedTree(
  destination: string,
  archive: EmbeddedArchive,
  allowedDirectories: ReadonlySet<string>,
  platform: NodeJS.Platform,
): Promise<void> {
  const expectedFiles = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const observedFiles = new Set<string>();
  const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw incomplete("extracted runtime contains a symlink", { archive: archive.key, path: relative });
      }
      if (metadata.isDirectory()) {
        if (!allowedDirectories.has(relative)) {
          throw incomplete("extracted runtime contains an unexpected directory", { archive: archive.key, path: relative });
        }
        await visit(absolute, relative);
        if (platform !== "win32") await chmod(absolute, 0o700);
      } else if (metadata.isFile()) {
        const expected = expectedFiles.get(relative);
        if (!expected || observedFiles.has(relative) || metadata.nlink !== 1) {
          throw incomplete("extracted runtime contains an unexpected, duplicate, or hard-linked file", {
            archive: archive.key,
            path: relative,
          });
        }
        observedFiles.add(relative);
        const actualHash = await digestFile(absolute);
        if (actualHash !== expected.sha256) {
          throw incomplete("extracted runtime file checksum mismatch", {
            archive: archive.key,
            path: relative,
            expected: expected.sha256,
            actual: actualHash,
          });
        }
        if (platform !== "win32") await chmod(absolute, expected.mode);
      } else {
        throw incomplete("extracted runtime contains a special file", { archive: archive.key, path: relative });
      }
    }
  };
  await visit(destination);
  const missing = [...expectedFiles.keys()].filter((entryPath) => !observedFiles.has(entryPath));
  if (missing.length > 0) {
    throw incomplete("extracted runtime is missing verified files", { archive: archive.key, missing });
  }
}

/**
 * Extracts one verified archive into a newly-created directory. Header preflight
 * completes before the destination exists, so rejected archives write no files.
 */
export async function extractRuntimeArchive(
  input: ExtractRuntimeArchiveInput,
): Promise<ExtractedRuntimeArchive> {
  const platform = input.platform ?? process.platform;
  if (!path.isAbsolute(input.destination)) {
    rejectArchive("runtime extraction destination must be absolute", { destination: input.destination });
  }
  const inspection = await inspectArchive(input.bytes, input.archive);
  let created = false;
  try {
    await mkdir(input.destination, { recursive: false, mode: 0o700 });
    created = true;
    if (platform === "win32") {
      secureAppDataDirectorySync(input.destination, platform, input.aclRunner);
    } else {
      await chmod(input.destination, 0o700);
    }
    const unpack = extract({
      cwd: input.destination,
      strict: true,
      maxDecompressionRatio: archiveExpansionLimit(input.archive.bytes) / input.archive.bytes,
      preservePaths: false,
      noChmod: true,
      noMtime: true,
    });
    await consumeTar(unpack, archiveBuffer(input.bytes));
    await input.hooks?.afterExtract?.();
    await verifyExtractedTree(input.destination, input.archive, inspection.directories, platform);
    return { files: input.archive.entries.length, bytes: inspection.unpackedBytes };
  } catch (error) {
    let cleanupError: unknown;
    if (created) {
      try {
        await rm(input.destination, { recursive: true, force: true });
      } catch (caught) {
        cleanupError = caught;
      }
    }
    if (cleanupError) {
      throw incomplete("runtime archive cleanup failed", {
        archive: input.archive.key,
        cause: error instanceof Error ? error.message : String(error),
        cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    if (error instanceof RuntimeAssetError) throw error;
    throw incomplete("runtime archive extraction failed", {
      archive: input.archive.key,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
