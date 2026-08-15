import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { ErrorCode, type DomainError } from "@vidcom/contracts";
import {
  importDecision,
  importRefusal,
  type AbsolutePath,
  type CanonicalImportPaths,
  type ImportEntryKind,
  type ImportPlan,
} from "@vidcom/core";

const MARKER_FILE = ".vidcom-import.json";

/**
 * The staging directory for one import.
 *
 * Inside the workspace, not in the OS temp directory. The final step is a
 * `rename`, and `rename` across devices fails with EXDEV — so staging somewhere
 * "convenient" turns the atomic commit into a copy that can be interrupted
 * halfway, which is the entire thing this design avoids.
 */
export function stagingPathFor(plan: ImportPlan, operationId: string): string {
  return path.join(plan.workspaceRoot, `.${plan.slug}.vidcom-import-${operationId}.tmp`);
}

export interface ImportStagingMarker {
  operationId: string;
  slug: string;
  source: string;
  target: string;
  startedAt: string;
}

function toggleCaseCandidate(target: string): string | null {
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const value = target[index];
    if (value && /[a-z]/u.test(value)) {
      return `${target.slice(0, index)}${value.toUpperCase()}${target.slice(index + 1)}`;
    }
    if (value && /[A-Z]/u.test(value)) {
      return `${target.slice(0, index)}${value.toLowerCase()}${target.slice(index + 1)}`;
    }
  }
  return null;
}

async function isCaseInsensitivePath(canonicalPath: string): Promise<boolean> {
  const alternate = toggleCaseCandidate(canonicalPath);
  if (alternate === null || alternate === canonicalPath) return process.platform === "win32";
  try {
    return await realpath(alternate) === canonicalPath;
  } catch {
    return false;
  }
}

/** Resolves physical roots and the case semantics of their existing volumes. */
export async function canonicalImportPaths(
  source: string,
  workspaceRoot: string,
): Promise<CanonicalImportPaths> {
  const [canonicalSource, canonicalWorkspace] = await Promise.all([
    realpath(source),
    realpath(workspaceRoot),
  ]);
  const [sourceInsensitive, workspaceInsensitive] = await Promise.all([
    isCaseInsensitivePath(canonicalSource),
    isCaseInsensitivePath(canonicalWorkspace),
  ]);
  return {
    source: canonicalSource as AbsolutePath,
    workspaceRoot: canonicalWorkspace as AbsolutePath,
    caseInsensitive: sourceInsensitive || workspaceInsensitive,
  };
}

/**
 * Identity the plan is bound to, cheap enough to recheck before the copy.
 *
 * Device and inode rather than the path, because a path can be repointed at
 * something else and is the same string afterwards. The inode change time is in
 * there too, and it earns its place: Linux hands the freed inode straight back,
 * so deleting a directory and creating another in its place can produce the
 * same `dev:ino` — measured on CI, not guessed. The change time moves whenever
 * the inode does, which is precisely the event this has to notice.
 */
export async function sourceIdentityOf(source: string): Promise<string> {
  const info = await stat(source, { bigint: true });
  return `${info.dev}:${info.ino}:${info.ctimeNs}`;
}

export interface CopyReport {
  files: number;
  directories: number;
  skipped: number;
}

export interface CopyIntoStagingOptions {
  /** Root identity captured when the job was queued. */
  expectedSourceIdentity?: string;
  /** Real-filesystem race seam: called after lstat and before opening an entry. */
  afterEntryStat?: (relativePath: string) => Promise<void> | void;
}

function changed(relativePath: string): DomainError {
  return {
    code: ErrorCode.WriteConflict,
    message: "the import source changed while it was being copied",
    details: { path: relativePath },
  };
}

function sameIdentity(
  left: { dev: bigint; ino: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; ctimeNs: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs;
}

async function copyRegularFileBound(
  source: string,
  target: string,
  relativePath: string,
  expected: BigIntStats,
): Promise<DomainError | null> {
  let sourceHandle;
  let targetHandle;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await sourceHandle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(expected, opened)) return changed(relativePath);
    targetHandle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      Number(opened.mode) & 0o777,
    );
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await targetHandle.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameIdentity(opened, after)) return changed(relativePath);
    await targetHandle.sync();
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(code ?? "")) return changed(relativePath);
    throw error;
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

/**
 * Copies the source tree into staging, reading only.
 *
 * Nothing here writes to the source, not even a timestamp: the user still has
 * the original after a failed import, and "still has" has to mean unchanged.
 */
export async function copyIntoStaging(
  source: string,
  staging: string,
  options: CopyIntoStagingOptions = {},
): Promise<CopyReport | DomainError> {
  if (options.expectedSourceIdentity !== undefined
    && await sourceIdentityOf(source) !== options.expectedSourceIdentity) {
    return changed("");
  }
  const report: CopyReport = { files: 0, directories: 0, skipped: 0 };
  const walk = async (relative: string): Promise<DomainError | null> => {
    const directory = path.join(source, relative);
    const directoryBefore = await lstat(directory, { bigint: true });
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) return changed(relative);
    await mkdir(path.join(staging, relative), { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });
    const directoryAfter = await lstat(directory, { bigint: true });
    if (!sameIdentity(directoryBefore, directoryAfter)) return changed(relative);
    for (const entry of entries) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const from = path.join(source, childRelative);
      const observed = await lstat(from, { bigint: true });
      const kind: ImportEntryKind = observed.isSymbolicLink()
        ? "symlink"
        : observed.isDirectory()
          ? "directory"
          : observed.isFile() ? "file" : "other";
      const refusal = importRefusal(childRelative, kind);
      if (refusal) return refusal;
      if (!importDecision(childRelative, kind).copy) {
        report.skipped += 1;
        continue;
      }
      await options.afterEntryStat?.(childRelative);
      if (kind === "directory") {
        report.directories += 1;
        const nested = await walk(childRelative);
        if (nested) return nested;
        continue;
      }
      const failure = await copyRegularFileBound(
        from,
        path.join(staging, childRelative),
        childRelative,
        observed,
      );
      if (failure) return failure;
      report.files += 1;
    }
    return null;
  };
  const failure = await walk("");
  if (failure) return failure;
  if (options.expectedSourceIdentity !== undefined
    && await sourceIdentityOf(source) !== options.expectedSourceIdentity) {
    return changed("");
  }
  return report;
}

const MAX_IMPORT_MARKER_BYTES = 1 * 1_024 * 1_024;

async function readRequiredRegularFile(
  root: string,
  name: string,
  readContent = true,
): Promise<string | DomainError> {
  try {
    const handle = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        return { code: ErrorCode.PathInvalid, message: `${name} must be a regular file` };
      }
      if (readContent && info.size > MAX_IMPORT_MARKER_BYTES) {
        return { code: ErrorCode.TooLarge, message: `${name} is too large to validate safely` };
      }
      return readContent ? await handle.readFile("utf8") : "";
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      code: ErrorCode.PathInvalid,
      message: `${name} is required and must not be a symlink`,
      details: { code: (error as NodeJS.ErrnoException).code ?? "unknown" },
    };
  }
}

/** Validates the minimum project contract while the tree is still disposable staging. */
export async function validateStagedProject(staging: string): Promise<DomainError | null> {
  const [configContent, identityContent, entryContent] = await Promise.all([
    readRequiredRegularFile(staging, "hyperframes.json"),
    readRequiredRegularFile(staging, "vidcom.json"),
    readRequiredRegularFile(staging, "index.html", false),
  ]);
  if (typeof configContent !== "string") return configContent;
  if (typeof identityContent !== "string") return identityContent;
  if (typeof entryContent !== "string") return entryContent;
  try {
    const config = JSON.parse(configContent) as unknown;
    if (config === null || typeof config !== "object" || Array.isArray(config)) throw new TypeError();
  } catch {
    return { code: ErrorCode.PathInvalid, message: "hyperframes.json must contain a JSON object" };
  }
  try {
    const identity = JSON.parse(identityContent) as { id?: unknown };
    if (typeof identity.id !== "string" || identity.id.trim().length === 0) throw new TypeError();
  } catch {
    return { code: ErrorCode.PathInvalid, message: "vidcom.json must contain a non-empty ProjectId" };
  }
  return null;
}

/**
 * Writes the marker that makes recovery possible.
 *
 * Recovery finishes or removes what a marker describes and touches nothing
 * else. A sweep of "directories that look temporary" would eventually delete
 * something a user put there.
 */
export async function writeStagingMarker(
  staging: string,
  marker: ImportStagingMarker,
): Promise<void> {
  await mkdir(staging, { recursive: true });
  await writeFile(
    path.join(staging, MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

export async function readStagingMarker(staging: string): Promise<ImportStagingMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(staging, MARKER_FILE), "utf8")) as
      Partial<ImportStagingMarker>;
    if (typeof parsed.operationId !== "string" || typeof parsed.target !== "string") return null;
    return parsed as ImportStagingMarker;
  } catch {
    // A marker that cannot be read is treated as no marker, which leaves the
    // directory alone. The conservative direction here is the opposite of the
    // download marker's: that one guards a cache we may re-fetch, this one sits
    // in the user's workspace, and deleting a tree we cannot identify is worse
    // than leaving one behind.
    return null;
  }
}

/** Every staging directory this workspace currently holds, marker included. */
export async function listStagingDirectories(workspaceRoot: string): Promise<Array<{
  staging: string;
  marker: ImportStagingMarker;
}>> {
  const found: Array<{ staging: string; marker: ImportStagingMarker }> = [];
  let entries;
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    // An unreadable workspace has nothing to recover, and recovery runs at
    // start-up: failing here would stop a daemon from booting over a directory
    // problem the user will see reported everywhere else.
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/\.vidcom-import-.+\.tmp$/u.test(entry.name)) continue;
    const staging = path.join(workspaceRoot, entry.name);
    const marker = await readStagingMarker(staging);
    // No marker, no action. A directory that merely looks like staging may be
    // something a person made, and deleting it would be this code guessing.
    if (marker !== null) found.push({ staging, marker });
  }
  return found;
}

export interface ImportRecoveryOutcome {
  staging: string;
  action: "committed" | "removed" | "left";
}

/**
 * Finishes or clears what a previous run started.
 *
 * Committed when the operation is recorded as complete and the target is still
 * free — the rename is the only step that was left. Removed when it is not:
 * a partial copy is worth nothing, and leaving it means the next import picks
 * a different slug to avoid a directory nobody wants.
 */
export async function recoverImportStaging(
  workspaceRoot: string,
  isCommitted: (operationId: string) => Promise<boolean>,
): Promise<ImportRecoveryOutcome[]> {
  const outcomes: ImportRecoveryOutcome[] = [];
  for (const { staging, marker } of await listStagingDirectories(workspaceRoot)) {
    if (await isCommitted(marker.operationId)) {
      try {
        // Rename first, then drop the marker from where it landed. Removing it
        // before the rename means a rename that fails leaves a staging
        // directory no recovery can ever recognise again — it becomes rubbish
        // in the user's workspace that nothing will clean up.
        await rename(staging, marker.target);
        await rm(path.join(marker.target, MARKER_FILE), { force: true });
        outcomes.push({ staging, action: "committed" });
        continue;
      } catch {
        // The target appeared while we were away, or the rename is not allowed.
        // Leaving it is safer than deleting a tree that the database says is a
        // finished import.
        outcomes.push({ staging, action: "left" });
        continue;
      }
    }
    await rm(staging, { recursive: true, force: true });
    outcomes.push({ staging, action: "removed" });
  }
  return outcomes;
}

/** Moves staging into place. Fails loudly rather than merging into an existing directory. */
export async function commitStaging(staging: string, target: string): Promise<DomainError | null> {
  try {
    // Same order as recovery, for the same reason: a marker removed before a
    // rename that then fails leaves a directory recovery cannot identify.
    await rename(staging, target);
    await rm(path.join(target, MARKER_FILE), { force: true });
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      code: code === "EXDEV" ? ErrorCode.PathInvalid : ErrorCode.StorageUnavailable,
      message: code === "EXDEV"
        // Named explicitly because the fix is structural, not a retry.
        ? "staging ended up on a different filesystem, so the import cannot be committed atomically"
        : "the import could not be moved into the workspace",
      details: { code: code ?? "unknown" },
    };
  }
}

/** Digest of the staged tree, so a caller can prove the copy is complete. */
export async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`d ${childRelative}\n`);
        await walk(childRelative);
        continue;
      }
      if (entry.isSymbolicLink()) {
        hash.update(`l ${childRelative} ${await readlink(path.join(root, childRelative))}\n`);
        continue;
      }
      const info = await stat(path.join(root, childRelative));
      hash.update(`f ${childRelative} ${info.size}\n`);
    }
  };
  await walk("");
  return `sha256:${hash.digest("hex")}`;
}
