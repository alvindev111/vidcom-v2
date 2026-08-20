/**
 * Unsaved editor text, and what happens to it when the file changes underneath (R8.1d).
 *
 * Every rule here is about ordering, and ordering is exactly what a component
 * cannot be trusted with: a change event and a save response race, and the wrong
 * winner either loses the user's typing or silently overwrites someone else's
 * work. So this is a plain reducer with no I/O, and the component only reports
 * what happened.
 */

export interface DraftIncoming {
  hash: string | null;
  /** `null` means the file was deleted (or renamed away) outside the app. */
  content: string | null;
  revision: number;
}

export interface DraftEntry {
  path: string;
  /** Disk authority independent from whether the editor text is dirty. */
  sourceStatus: "present" | "deleted" | "conflicted";
  /** Hash the draft is based on; `null` once the file is known to be gone. */
  baseHash: string | null;
  baseRevision: number;
  draft: string;
  /** `changeSeq` of this draft's own last settled save. */
  acknowledgedChangeSeq: number;
  /** Newest event sequence a refetch has been started for. */
  incomingGeneration: number;
  incomingStatus: "idle" | "loading" | "ready" | "failed";
  incoming: DraftIncoming | null;
  resolution: "editing" | "conflicted" | "resolved-keep" | "resolved-take";
}

export interface DraftState {
  entries: Record<string, DraftEntry>;
}

export type DraftEvent =
  | { kind: "opened"; path: string; content: string; contentHash: string; revision: number }
  | { kind: "edited"; path: string; draft: string }
  | { kind: "discarded"; path: string }
  /** A durable event named these paths; the bytes are not in it. */
  | { kind: "external"; paths: readonly string[]; seq: number }
  /** The event stream lost continuity, so nothing open can be trusted. */
  | { kind: "resynced"; seq: number }
  | { kind: "incoming"; path: string; generation: number; content: string | null; contentHash: string | null; revision: number }
  | { kind: "incoming-failed"; path: string; generation: number }
  | { kind: "retry"; path: string }
  | { kind: "keep"; path: string }
  | { kind: "take"; path: string }
  | { kind: "compare"; path: string }
  | { kind: "saved"; path: string; contentHash: string; revision: number; changeSeq: number | null };

function newEntry(input: { path: string; content: string; contentHash: string; revision: number }): DraftEntry {
  return {
    path: input.path,
    sourceStatus: "present",
    baseHash: input.contentHash,
    baseRevision: input.revision,
    draft: input.content,
    acknowledgedChangeSeq: 0,
    incomingGeneration: 0,
    incomingStatus: "idle",
    incoming: null,
    resolution: "editing",
  };
}

export function openDraft(
  state: DraftState,
  input: { path: string; content: string; contentHash: string; revision: number },
): DraftState {
  return { entries: { ...state.entries, [input.path]: newEntry(input) } };
}

/** Starts the conflict gate for one path: save is off before any fetch begins. */
function beginRefetch(entry: DraftEntry, seq: number): DraftEntry {
  return {
    ...entry,
    sourceStatus: "conflicted",
    incomingGeneration: seq,
    incomingStatus: "loading",
    incoming: null,
    resolution: "conflicted",
  };
}

function rebase(entry: DraftEntry, draft: string, resolution: DraftEntry["resolution"]): DraftEntry {
  const incoming = entry.incoming;
  return {
    ...entry,
    sourceStatus: incoming?.content === null ? "deleted" : "present",
    draft,
    baseHash: incoming ? incoming.hash : entry.baseHash,
    baseRevision: incoming ? incoming.revision : entry.baseRevision,
    incoming: null,
    incomingStatus: "idle",
    resolution,
  };
}

function map(state: DraftState, path: string, change: (entry: DraftEntry) => DraftEntry): DraftState {
  const entry = state.entries[path];
  if (!entry) return state;
  return { entries: { ...state.entries, [path]: change(entry) } };
}

export function reduceDraft(state: DraftState, event: DraftEvent): DraftState {
  switch (event.kind) {
    case "opened":
      return openDraft(state, event);
    case "edited":
      return map(state, event.path, (entry) => ({ ...entry, draft: event.draft }));
    case "discarded": {
      if (!state.entries[event.path]) return state;
      const entries = { ...state.entries };
      delete entries[event.path];
      return { entries };
    }
    case "external": {
      const touched = new Set(conflicts(state, event.paths));
      const entries = { ...state.entries };
      for (const path of touched) {
        const entry = entries[path]!;
        // The studio's own save already advanced the acknowledgement; its echo is
        // not a change to resolve against.
        if (event.seq <= entry.acknowledgedChangeSeq || event.seq <= entry.incomingGeneration) continue;
        entries[path] = beginRefetch(entry, event.seq);
      }
      return { entries };
    }
    case "resynced": {
      // A gap means unknown writes went by, so every open draft is refetched.
      const entries = { ...state.entries };
      for (const [path, entry] of Object.entries(entries)) entries[path] = beginRefetch(entry, event.seq);
      return { entries };
    }
    case "incoming":
      return map(state, event.path, (entry) => entry.incomingGeneration !== event.generation
        ? entry
        : {
            ...entry,
            sourceStatus: event.content === null ? "deleted" : "conflicted",
            incomingStatus: "ready",
            incoming: { hash: event.contentHash, content: event.content, revision: event.revision },
            resolution: "conflicted",
          });
    case "incoming-failed":
      return map(state, event.path, (entry) => entry.incomingGeneration !== event.generation
        ? entry
        // Still conflicted, still unsaveable: falling back to the stale base is
        // how an unread change gets overwritten.
        : {
            ...entry,
            sourceStatus: "conflicted",
            incomingStatus: "failed",
            incoming: null,
            resolution: "conflicted",
          });
    case "retry":
      return map(state, event.path, (entry) => entry.incomingStatus === "failed"
        ? { ...entry, sourceStatus: "conflicted", incomingStatus: "loading" }
        : entry);
    case "keep":
      return map(state, event.path, (entry) => entry.incomingStatus === "ready"
        ? rebase(entry, entry.draft, "resolved-keep")
        : entry);
    case "take":
      return map(state, event.path, (entry) => entry.incomingStatus === "ready"
        ? rebase(entry, entry.incoming?.content ?? entry.draft, "resolved-take")
        : entry);
    case "compare":
      // Comparing decides nothing: the conflict stays open and save stays off.
      return state;
    case "saved":
      return map(state, event.path, (entry) => {
        const base = { ...entry, baseHash: event.contentHash, baseRevision: event.revision };
        if (event.changeSeq === null) return base;
        const settles = entry.incomingGeneration <= event.changeSeq;
        return {
          ...base,
          acknowledgedChangeSeq: Math.max(entry.acknowledgedChangeSeq, event.changeSeq),
          ...(settles
            ? { incomingGeneration: 0, incomingStatus: "idle" as const, incoming: null, resolution: "editing" as const }
            : {}),
          ...(settles ? { sourceStatus: "present" as const } : {}),
        };
      });
  }
}

/**
 * Open drafts a set of changed paths touches.
 *
 * Whole segments only: a renamed parent directory covers every draft under it,
 * while `compositions` and `composition` share a prefix and nothing else.
 */
export function conflicts(state: DraftState, paths: readonly string[]): string[] {
  const covered = (changed: string, draft: string) =>
    draft === changed || draft.startsWith(`${changed}/`);
  return Object.keys(state.entries)
    .filter((draft) => paths.some((changed) => covered(changed, draft)))
    .sort();
}

/** True while this draft must not be written: something unread changed under it. */
export function saveDisabled(entry: DraftEntry): boolean {
  return entry.sourceStatus !== "present" || entry.resolution === "conflicted";
}

/** Precondition for the next save: `null` recreates a file deleted outside. */
export function savePrecondition(entry: DraftEntry): { expectedContentHash: string | null } {
  return { expectedContentHash: entry.baseHash };
}
