import { ErrorCode, type DomainError } from "@vidcom/contracts";

import type { AbsolutePath } from "../domain/models";
import { err, ok, type Result } from "../error/result";

/** Directories an import never copies, whatever the source contains. */
export const IMPORT_IGNORED_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  ".hyperframes",
];

export interface ImportPlan {
  source: AbsolutePath;
  workspaceRoot: AbsolutePath;
  /** The directory the import will create, already free of collisions. */
  slug: string;
  target: AbsolutePath;
  /** Canonical identity of the source, bound at plan time and rechecked before the copy. */
  sourceIdentity: string;
}

export interface ImportPlanInput extends PathComparison {
  source: AbsolutePath;
  workspaceRoot: AbsolutePath;
  targetName?: string;
  sourceIdentity: string;
  /** Slugs already taken in the workspace, so a collision is resolved before any I/O. */
  taken: readonly string[];
}

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return { code: ErrorCode.PathInvalid, message, ...(details === undefined ? {} : { details }) };
}

/**
 * Case folding is the caller's decision, not this module's.
 *
 * Whether two paths that differ only in case are the same path is a property of
 * the filesystem, and Core is not allowed to ask which one it is running on.
 * The adapter knows and passes it in.
 */
export interface PathComparison {
  caseInsensitive?: boolean;
}

/** Normalises separators so a Windows path compares the same way a POSIX one does. */
function normalise(target: string, options: PathComparison = {}): string {
  const forward = target.split("\\").join("/").replace(/\/+$/u, "");
  return options.caseInsensitive === true ? forward.toLowerCase() : forward;
}

/**
 * Whether one path contains another, by path segments.
 *
 * Segment-wise rather than by prefix: `/work/videos` is not inside
 * `/work/video`, and a string prefix test says it is.
 */
export function contains(parent: string, child: string, options: PathComparison = {}): boolean {
  const from = normalise(parent, options);
  const to = normalise(child, options);
  return to === from || to.startsWith(`${from}/`);
}

/**
 * Refuses a source that overlaps the workspace.
 *
 * All three directions, and all of them before a single byte is copied: a
 * source inside the workspace copies itself into its own subtree and recurses
 * until the disk fills, and a source that *is* the workspace does the same
 * thing one level up.
 */
export function assertNoOverlap(
  source: AbsolutePath,
  workspaceRoot: AbsolutePath,
  options: PathComparison = {},
): Result<null, DomainError> {
  if (normalise(source, options) === normalise(workspaceRoot, options)) {
    return err(invalid("the source is the workspace itself"));
  }
  if (contains(workspaceRoot, source, options)) {
    return err(invalid("the source is already inside this workspace"));
  }
  if (contains(source, workspaceRoot, options)) {
    return err(invalid("the source contains this workspace"));
  }
  return ok(null);
}

const SLUG_UNSAFE = /[^a-z0-9-]+/gu;

/** Folder name to slug: lowercase, ASCII, no separators a filesystem argues about. */
export function slugFor(name: string): string {
  const slug = name.trim().toLowerCase().replace(SLUG_UNSAFE, "-").replace(/^-+|-+$/gu, "");
  return slug.length === 0 ? "project" : slug;
}

/**
 * Picks a free name, counting up.
 *
 * The alternative — overwriting, or refusing — either destroys a project or
 * makes the user rename a folder before an import they already asked for.
 */
export function availableSlug(
  preferred: string,
  taken: readonly string[],
  options: PathComparison = {},
): string {
  const used = new Set(taken.map((name) => normalise(name, options)));
  if (!used.has(normalise(preferred, options))) return preferred;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${preferred}-${suffix}`;
    if (!used.has(normalise(candidate, options))) return candidate;
  }
}

/**
 * Decides everything before anything is touched.
 *
 * The plan binds the source's canonical identity, the free target name and the
 * overlap verdict together. `execute` rechecks the identity before it copies,
 * because between planning and copying somebody can move or replace the source
 * — and copying whatever now sits at that path is the worst outcome available.
 */
export function planProjectImport(input: ImportPlanInput): Result<ImportPlan, DomainError> {
  const comparison: PathComparison = input.caseInsensitive === undefined
    ? {}
    : { caseInsensitive: input.caseInsensitive };
  const overlap = assertNoOverlap(input.source, input.workspaceRoot, comparison);
  if (!overlap.ok) return overlap;

  const preferred = slugFor(input.targetName ?? lastSegment(input.source));
  const slug = availableSlug(preferred, input.taken, comparison);
  return ok({
    source: input.source,
    workspaceRoot: input.workspaceRoot,
    slug,
    target: `${input.workspaceRoot.replace(/[/\\]+$/u, "")}/${slug}` as AbsolutePath,
    sourceIdentity: input.sourceIdentity,
  });
}

function lastSegment(target: string): string {
  const parts = target.split(/[/\\]/u).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "project";
}

/**
 * Refuses to copy the source once it is no longer the source that was planned.
 *
 * "Identity" here is whatever the caller can compare cheaply and honestly — a
 * canonical path plus an inode, or a digest. What matters is that a changed
 * answer stops the import rather than quietly importing something else.
 */
export function assertSourceUnchanged(
  plan: ImportPlan,
  identityNow: string,
): Result<null, DomainError> {
  if (identityNow === plan.sourceIdentity) return ok(null);
  return err({
    code: ErrorCode.WriteConflict,
    message: "the source changed between planning and copying this import",
    details: { expected: plan.sourceIdentity, actual: identityNow },
  });
}

export type ImportEntryKind = "file" | "directory" | "symlink" | "other";

/**
 * What may be copied.
 *
 * Symlinks are refused rather than followed or skipped (R7.11): following one
 * copies data from outside the source, and skipping it silently produces a
 * project that is missing something the original had.
 */
export function importDecision(
  relativePath: string,
  kind: ImportEntryKind,
): { copy: boolean; reason?: string } {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => IMPORT_IGNORED_DIRECTORIES.includes(segment))) {
    return { copy: false, reason: "ignored directory" };
  }
  if (kind === "symlink") return { copy: false, reason: "symlink" };
  if (kind === "other") return { copy: false, reason: "not a regular file or directory" };
  return { copy: true };
}

/** A symlink stops the import; an ignored directory does not. */
export function importRefusal(
  relativePath: string,
  kind: ImportEntryKind,
): DomainError | null {
  const decision = importDecision(relativePath, kind);
  if (decision.copy || decision.reason === "ignored directory") return null;
  return invalid(`refusing to import ${decision.reason ?? "this entry"}`, { path: relativePath });
}
