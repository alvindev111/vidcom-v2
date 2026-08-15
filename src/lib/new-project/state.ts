export const PRESET_IDS = ["vertical-shorts", "horizontal-youtube", "custom"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface NewProjectDraft {
  name: string;
  presetId: PresetId;
}

export interface NewProjectState {
  draft: NewProjectDraft;
  submitting: boolean;
  error?: { code: string; message: string };
  createdSlug?: string;
}

export const EMPTY_DRAFT: NewProjectState = {
  draft: { name: "", presetId: "horizontal-youtube" },
  submitting: false,
};

export type NewProjectAction =
  | { kind: "edited"; draft: Partial<NewProjectDraft> }
  | { kind: "submitting" }
  | { kind: "created"; slug: string }
  | { kind: "failed"; code: string; message: string };

export function newProjectReducer(state: NewProjectState, action: NewProjectAction): NewProjectState {
  switch (action.kind) {
    case "edited":
      // Editing clears the last error: a message about the previous name is
      // wrong the moment the name changes.
      return {
        ...state,
        draft: { ...state.draft, ...action.draft },
        ...state.error ? { error: undefined } : {},
      };
    case "submitting":
      return { ...state, submitting: true, error: undefined };
    case "created":
      return { ...state, submitting: false, createdSlug: action.slug };
    case "failed":
      // Submitting returns to false so the user can correct and retry; a dialog
      // stuck disabled after a rejected name is a dialog they have to close.
      return { ...state, submitting: false, error: { code: action.code, message: action.message } };
  }
}

export type DraftProblem = "empty-name" | "name-too-long";

/** Why this draft cannot be submitted, or null when it can. */
export function draftProblem(draft: NewProjectDraft): DraftProblem | null {
  const name = draft.name.trim();
  if (name.length === 0) return "empty-name";
  if (name.length > 255) return "name-too-long";
  return null;
}

/**
 * Whether a submit may start.
 *
 * False while one is in flight, which is what stops a double-submit from
 * creating two projects: a second click during the request would otherwise be
 * indistinguishable from the first.
 */
export function canSubmit(state: NewProjectState): boolean {
  return !state.submitting && draftProblem(state.draft) === null;
}
