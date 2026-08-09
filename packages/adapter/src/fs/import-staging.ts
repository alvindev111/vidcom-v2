import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ErrorCode, type DomainError } from "@vidcom/contracts";
import { importRefusal, type ImportEntryKind, type ImportPlan } from "@vidcom/core";

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

async function kindOf(target: string): Promise<ImportEntryKind> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
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
  const info = await stat(source);
  return `${info.dev}:${info.ino}:${info.ctimeMs}`;
}

export interface CopyReport {
  files: number;
  directories: number;
  skipped: number;
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
  report: CopyReport = { files: 0, directories: 0, skipped: 0 },
  relative = "",
): Promise<CopyReport | DomainError> {
  await mkdir(path.join(staging, relative), { recursive: true });
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const from = path.join(source, childRelative);
    const kind = await kindOf(from);
    const refusal = importRefusal(childRelative, kind);
    if (refusal) return refusal;
    if (kind === "symlink" || kind === "other") {
      // Unreachable while `importRefusal` refuses both, and kept so a future
      // change to that rule cannot silently start copying them.
      report.skipped += 1;
      continue;
    }
    if (!importDecisionCopies(childRelative, kind)) {
      report.skipped += 1;
      continue;
    }
    if (kind === "directory") {
      report.directories += 1;
      const nested = await copyIntoStaging(source, staging, report, childRelative);
      if (!isReport(nested)) return nested;
      continue;
    }
    await copyFile(from, path.join(staging, childRelative));
    report.files += 1;
  }
  return report;
}

function isReport(value: CopyReport | DomainError): value is CopyReport {
  return "files" in value;
}

function importDecisionCopies(relativePath: string, kind: ImportEntryKind): boolean {
  return importRefusal(relativePath, kind) === null
    && !relativePath.split("/").some((segment) => segment === "node_modules"
      || segment === ".git"
      || segment === ".hyperframes");
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
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(path.join(staging, MARKER_FILE), "utf8")) as
      Partial<ImportStagingMarker>;
    if (typeof parsed.operationId !== "string" || typeof parsed.target !== "string") return null;
    return parsed as ImportStagingMarker;
  } catch {
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
        await rm(path.join(staging, MARKER_FILE), { force: true });
        await rename(staging, marker.target);
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
    await rm(path.join(staging, MARKER_FILE), { force: true });
    await rename(staging, target);
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
