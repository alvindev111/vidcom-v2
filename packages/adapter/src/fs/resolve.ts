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
  type AbsolutePath,
  type MutationDirectoryIdentity,
  type MutationPathLease,
} from "@vidcom/core";

const WRITE_PURPOSES = new Set<PathPurpose>([
  "authored-write",
  "write-source",
  "write-asset",
  "system-write",
  "state-write",
]);

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

async function containsSymlink(root: string, target: string): Promise<boolean> {
  if ((await lstat(root)).isSymbolicLink()) return true;
  const relative = path.relative(root, target);
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

async function directoryState(pathname: string): Promise<
  | { kind: "directory"; identity: MutationDirectoryIdentity }
  | { kind: "absent" | "unsafe" }
> {
  try {
    const value = await lstat(pathname, { bigint: true });
    if (value.isSymbolicLink() || !value.isDirectory()) return { kind: "unsafe" };
    return { kind: "directory", identity: {
      device: value.dev.toString(), inode: value.ino.toString(), mode: value.mode.toString(),
      canonicalPath: await realpath(pathname),
    } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

function sameIdentity(left: MutationDirectoryIdentity, right: MutationDirectoryIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.canonicalPath === right.canonicalPath;
}

/** Resolves one project path through syntax, canonical containment and purpose checks. */
export async function resolveProjectPath(
  ref: ProjectRef,
  relativePath: string,
  purpose: PathPurpose,
): Promise<Result<ResolvedPath, PathRejection>> {
  // This resolver is project-scoped. Agent-kit targets are workspace-relative
  // and must be resolved only by WorkspaceMutationCoordinator's adapter.
  if (purpose === "workspace-agent-kit") return err({ reason: "not_allowed_for_purpose" });
  const syntaxError = checkPathSyntax(relativePath);
  if (syntaxError) return err(syntaxError);
  const inputPurposeError = checkPathPurpose(relativePath, purpose);
  if (inputPurposeError) return err(inputPurposeError);

  if (WRITE_PURPOSES.has(purpose) && (await lstat(ref.root)).isSymbolicLink()) {
    return err({ reason: "symlink_escape" });
  }
  const canonicalRoot = await realpath(ref.root);
  const joined = path.resolve(canonicalRoot, relativePath);
  if (!contained(canonicalRoot, joined)) return err({ reason: "outside_project" });
  if (WRITE_PURPOSES.has(purpose) && await containsSymlink(canonicalRoot, joined)) {
    return err({ reason: "symlink_escape" });
  }

  const { ancestor, suffix } = await nearestExistingAncestor(joined);
  const canonicalAncestor = await realpath(ancestor);
  if (!contained(canonicalRoot, canonicalAncestor)) return err({ reason: "symlink_escape" });

  const canonicalTarget = path.join(canonicalAncestor, ...suffix);
  if (!contained(canonicalRoot, canonicalTarget)) return err({ reason: "symlink_escape" });

  const canonicalRelative = path.relative(canonicalRoot, canonicalTarget).split(path.sep).join("/");
  const targetPurposeError = checkPathPurpose(canonicalRelative, purpose);
  return targetPurposeError ? err(targetPurposeError) : ok(canonicalTarget as ResolvedPath);
}

/** Resolves a write target and freezes the identity of every existing parent directory. */
export async function resolveMutationPath(
  ref: ProjectRef,
  relativePath: string,
  purpose: PathPurpose,
): Promise<Result<MutationPathLease, PathRejection>> {
  if (!WRITE_PURPOSES.has(purpose)) return err({ reason: "not_allowed_for_purpose" });
  const resolved = await resolveProjectPath(ref, relativePath, purpose);
  if (!resolved.ok) return resolved;
  const canonicalRoot = await realpath(ref.root) as ResolvedPath;
  const parent = path.dirname(resolved.value);
  const relativeParent = path.relative(canonicalRoot, parent);
  const parentPaths = [
    canonicalRoot,
    ...relativeParent.split(path.sep).filter(Boolean).map((_, index, components) =>
      path.join(canonicalRoot, ...components.slice(0, index + 1)) as ResolvedPath),
  ];
  const parents = [];
  for (const parentPath of parentPaths) {
    const state = await directoryState(parentPath);
    if (state.kind === "unsafe" || (state.kind === "absent" && parentPath === canonicalRoot)) {
      return err({ reason: "symlink_escape" });
    }
    parents.push({ path: parentPath, identity: state.kind === "directory" ? state.identity : null });
  }
  return ok({ target: resolved.value, canonicalRoot, parents });
}

/** Revalidates a lease without following any parent symlink. */
export async function revalidateMutationPath(lease: MutationPathLease): Promise<boolean> {
  try {
    for (const parent of lease.parents) {
      const current = await directoryState(parent.path);
      if (parent.identity === null) {
        if (current.kind === "unsafe") return false;
        if (current.kind === "directory"
          && !contained(lease.canonicalRoot, current.identity.canonicalPath)) return false;
        continue;
      }
      if (current.kind !== "directory" || !sameIdentity(parent.identity, current.identity)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Rebuilds only one journal-restored parent while preserving every other frozen identity. */
export async function refreshMutationPath(
  lease: MutationPathLease,
  restoredParent: ResolvedPath,
): Promise<MutationPathLease | null> {
  try {
    let restored = false;
    const parents = [];
    for (const parent of lease.parents) {
      const current = await directoryState(parent.path);
      if (parent.path === restoredParent) {
        if (restored || current.kind !== "directory"
          || !contained(lease.canonicalRoot, current.identity.canonicalPath)) return null;
        restored = true;
        parents.push({ path: parent.path, identity: current.identity });
        continue;
      }
      if (parent.identity === null) {
        if (current.kind === "unsafe") return null;
        if (current.kind === "directory"
          && !contained(lease.canonicalRoot, current.identity.canonicalPath)) return null;
      } else {
        const pendingNestedRestore = current.kind === "absent"
          && parent.path !== restoredParent
          && contained(restoredParent, parent.path);
        if (!pendingNestedRestore
          && (current.kind !== "directory" || !sameIdentity(parent.identity, current.identity))) return null;
      }
      parents.push({
        path: parent.path,
        identity: parent.identity,
      });
    }
    return restored ? { ...lease, parents } : null;
  } catch {
    return null;
  }
}

/** Resolves the one workspace-scoped write purpose without inventing a pseudo-project. */
export async function resolveWorkspacePath(
  workspaceRoot: AbsolutePath,
  relativePath: string,
  purpose: "workspace-agent-kit",
): Promise<Result<ResolvedPath, PathRejection>> {
  const syntaxError = checkPathSyntax(relativePath);
  if (syntaxError) return err(syntaxError);
  const inputPurposeError = checkPathPurpose(relativePath, purpose);
  if (inputPurposeError) return err(inputPurposeError);

  const canonicalRoot = await realpath(workspaceRoot);
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
