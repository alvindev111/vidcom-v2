import type { AbsolutePath } from "./models";

/** A workspace candidate already checked for a valid project marker by the composition root. */
export interface WorkspaceCandidate {
  root: AbsolutePath;
  valid: boolean;
}

/** Ordered workspace inputs supplied at application composition time. */
export interface WorkspaceResolutionInput {
  explicit?: WorkspaceCandidate | null;
  active?: WorkspaceCandidate | null;
  cwd?: WorkspaceCandidate | null;
}

/** Result of deterministic workspace selection without directory creation or guessing. */
export type WorkspaceResolution =
  | { status: "resolved"; root: AbsolutePath; source: "explicit" | "active" | "cwd" }
  | { status: "selection_required" };

/** Resolves explicit, saved-active and marker-backed cwd candidates in strict priority order. */
export function resolveWorkspace(input: WorkspaceResolutionInput): WorkspaceResolution {
  if (input.explicit && !input.explicit.valid) return { status: "selection_required" };
  const candidates = [
    ["explicit", input.explicit],
    ["active", input.active],
    ["cwd", input.cwd],
  ] as const;

  for (const [source, candidate] of candidates) {
    if (candidate?.valid) return { status: "resolved", root: candidate.root, source };
  }
  return { status: "selection_required" };
}
