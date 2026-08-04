import { ErrorCode } from "@vidcom/contracts";

import type { AbsolutePath } from "./models";

export type WorkspaceSource = "explicit" | "cwd-project" | "cwd-solo" | "active" | "cwd";

/** A filesystem candidate whose facts were loaded by the composition root. */
export interface WorkspaceCandidate {
  root: AbsolutePath;
  readable: boolean;
  /** Presence only: an invalid identity file is still a project marker. */
  hasIdentityFile: boolean;
  parentReadable: boolean;
}

export interface WorkspaceWarning {
  code: "active_workspace_unreadable";
  path: string;
  reason: string;
}

export interface WorkspaceResolutionInput {
  explicit?: WorkspaceCandidate | null;
  active?: WorkspaceCandidate | null;
  cwd?: WorkspaceCandidate | null;
}

export type WorkspaceResolution =
  | {
      status: "resolved";
      root: AbsolutePath;
      source: WorkspaceSource;
      openProject: AbsolutePath | null;
      warnings: WorkspaceWarning[];
    }
  | { status: "error"; code: ErrorCode; path: string; reason: string };

/** Implements the approved eight-row workspace decision table without I/O. */
export function resolveWorkspace(input: WorkspaceResolutionInput): WorkspaceResolution {
  if (input.explicit) {
    if (!input.explicit.readable) return unreadable(input.explicit.root, "explicit workspace is not readable");
    return resolved(input.explicit.root, "explicit", null, []);
  }

  const cwd = input.cwd;
  if (cwd?.readable && cwd.hasIdentityFile) {
    return cwd.parentReadable
      ? resolved(parentOf(cwd.root), "cwd-project", cwd.root, [])
      : resolved(cwd.root, "cwd-solo", cwd.root, []);
  }

  const warnings: WorkspaceWarning[] = [];
  if (input.active) {
    if (input.active.readable) return resolved(input.active.root, "active", null, warnings);
    warnings.push({
      code: "active_workspace_unreadable",
      path: input.active.root,
      reason: "saved active workspace is not readable",
    });
  }

  if (cwd?.readable) return resolved(cwd.root, "cwd", null, warnings);
  return unreadable(cwd?.root ?? input.active?.root ?? ("" as AbsolutePath), "working directory is not readable");
}

function resolved(
  root: AbsolutePath,
  source: WorkspaceSource,
  openProject: AbsolutePath | null,
  warnings: WorkspaceWarning[],
): WorkspaceResolution {
  return { status: "resolved", root, source, openProject, warnings };
}

function unreadable(path: AbsolutePath, reason: string): WorkspaceResolution {
  return { status: "error", code: ErrorCode.PathInvalid, path, reason };
}

/** Pure dirname for already-absolute POSIX or Windows paths. */
function parentOf(root: AbsolutePath): AbsolutePath {
  const value = root.replace(/[\\/]+$/, "");
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (separator < 0) return root;
  if (separator === 0) return "/" as AbsolutePath;
  if (separator === 2 && /^[A-Za-z]:/.test(value)) return value.slice(0, 3) as AbsolutePath;
  return value.slice(0, separator) as AbsolutePath;
}
