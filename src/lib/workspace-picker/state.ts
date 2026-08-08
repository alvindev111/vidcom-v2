export interface PickerEntry {
  name: string;
  isDirectory: boolean;
  token?: string;
}

export interface PickerCrumb {
  label: string;
  token: string;
}

export interface PickerState {
  /** Trail from a root to where the user is now; the last entry is current. */
  crumbs: readonly PickerCrumb[];
  entries: readonly PickerEntry[];
  cursor?: string;
  loading: boolean;
  error?: { code: string; message: string };
}

export const EMPTY_PICKER: PickerState = { crumbs: [], entries: [], loading: false };

/**
 * Messages the picker reacts to.
 *
 * Kept as data so the whole flow can be exercised without rendering anything.
 * `vitest.config.ts` sets `environment: "node"` for the repo and there is no
 * jsdom, so behaviour that only exists inside a component is behaviour that
 * never gets tested.
 */
export type PickerAction =
  | { kind: "loading" }
  | { kind: "roots"; roots: readonly PickerCrumb[] }
  | { kind: "entered"; crumb: PickerCrumb; entries: readonly PickerEntry[]; cursor?: string }
  | { kind: "appended"; entries: readonly PickerEntry[]; cursor?: string }
  | { kind: "ascended"; token: string; entries: readonly PickerEntry[]; cursor?: string }
  | { kind: "created"; entry: PickerEntry }
  | { kind: "failed"; code: string; message: string };

function sortEntries(entries: readonly PickerEntry[]): PickerEntry[] {
  // Directories first, then by name: the list exists to be navigated, and a
  // folder buried among files is a folder the user has to hunt for.
  return [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, "en");
  });
}

export function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.kind) {
    case "loading":
      // The previous error is cleared here rather than on success: leaving it
      // up during a retry shows a failure that is no longer happening.
      return { ...state, loading: true, error: undefined };

    case "roots":
      // Roots reset the trail: they are where a browse starts, so anything the
      // user had navigated into no longer describes where they are.
      return {
        ...EMPTY_PICKER,
        entries: action.roots.map((root) => ({
          name: root.label,
          isDirectory: true,
          token: root.token,
        })),
      };

    case "entered":
      return {
        crumbs: [...state.crumbs, action.crumb],
        entries: sortEntries(action.entries),
        loading: false,
        ...action.cursor === undefined ? {} : { cursor: action.cursor },
      };

    case "appended":
      return {
        ...state,
        entries: sortEntries([...state.entries, ...action.entries]),
        loading: false,
        ...action.cursor === undefined ? {} : { cursor: action.cursor },
      };

    case "ascended": {
      // Truncate at the crumb clicked rather than popping one: a user clicking
      // three levels up expects to arrive there, not one level up.
      const index = state.crumbs.findIndex((crumb) => crumb.token === action.token);
      return {
        crumbs: index === -1 ? state.crumbs : state.crumbs.slice(0, index + 1),
        entries: sortEntries(action.entries),
        loading: false,
        ...action.cursor === undefined ? {} : { cursor: action.cursor },
      };
    }

    case "created":
      return { ...state, entries: sortEntries([...state.entries, action.entry]), loading: false };

    case "failed":
      // Entries are kept: a failed step should leave what was already loaded on
      // screen rather than emptying the pane the user was reading.
      return { ...state, loading: false, error: { code: action.code, message: action.message } };
  }
}

/** The directory a selection would activate, or null at a root listing. */
export function currentToken(state: PickerState): string | null {
  return state.crumbs.at(-1)?.token ?? null;
}

export function canLoadMore(state: PickerState): boolean {
  return state.cursor !== undefined && !state.loading;
}
