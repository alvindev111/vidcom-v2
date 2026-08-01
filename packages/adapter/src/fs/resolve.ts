import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { ErrorCode } from "@vidcom/contracts";
import {
  checkPathPurpose,
  checkPathSyntax,
  err,
  ok,
  type PathPurpose,
  type PathRejection,
  type ProjectRef,
  type ResolvedPath,
  type Result,
} from "@vidcom/core";

/** Stable security mapping shared by filesystem adapters and the HTTP error mapper. */
export const PATH_REJECTION_MAP = {
  invalid_syntax: {
    code: ErrorCode.PathInvalid,
    httpStatus: 400,
    message: "path is not a valid project-relative path",
  },
  outside_project: {
    code: ErrorCode.PathOutsideProject,
    httpStatus: 403,
    message: "path resolves outside the project",
  },
  symlink_escape: {
    code: ErrorCode.PathOutsideProject,
    httpStatus: 403,
    message: "path resolves outside the project",
  },
  not_allowed_for_purpose: {
    code: ErrorCode.AssetNotAllowed,
    httpStatus: 403,
    message: "this file is not served",
  },
} as const satisfies Record<PathRejection["reason"], object>;

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(target: string): Promise<{ ancestor: string; suffix: string[] }> {
  const suffix: string[] = [];
  let cursor = target;
  while (true) {
    try {
      await lstat(cursor);
      return { ancestor: cursor, suffix };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Resolves one project path through syntax, canonical containment and purpose checks. */
export async function resolveProjectPath(
  ref: ProjectRef,
  relativePath: string,
  purpose: PathPurpose,
): Promise<Result<ResolvedPath, PathRejection>> {
  const syntaxError = checkPathSyntax(relativePath);
  if (syntaxError) return err(syntaxError);
  const inputPurposeError = checkPathPurpose(relativePath, purpose);
  if (inputPurposeError) return err(inputPurposeError);

  const canonicalRoot = await realpath(ref.root);
  const joined = path.resolve(canonicalRoot, relativePath);
  if (!contained(canonicalRoot, joined)) return err({ reason: "outside_project" });

  const { ancestor, suffix } = await nearestExistingAncestor(joined);
  const canonicalAncestor = await realpath(ancestor);
  if (!contained(canonicalRoot, canonicalAncestor)) return err({ reason: "symlink_escape" });

  const canonicalTarget = path.join(canonicalAncestor, ...suffix);
  if (!contained(canonicalRoot, canonicalTarget)) return err({ reason: "symlink_escape" });

  const canonicalRelative = path.relative(canonicalRoot, canonicalTarget).split(path.sep).join("/");
  const targetPurposeError = checkPathPurpose(canonicalRelative, purpose);
  return targetPurposeError ? err(targetPurposeError) : ok(canonicalTarget as ResolvedPath);
}
