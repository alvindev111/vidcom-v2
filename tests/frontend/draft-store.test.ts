// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  conflicts,
  openDraft,
  reduceDraft,
  saveDisabled,
  type DraftState,
} from "@/lib/studio/draft-store";

const PATH = "compositions/scene-1.html";
const BASE = `sha256:${"a".repeat(64)}`;
const NEXT = `sha256:${"b".repeat(64)}`;
const THIRD = `sha256:${"c".repeat(64)}`;

function opened(draft = "typed"): DraftState {
  const state = reduceDraft({ entries: {} }, {
    kind: "opened",
    path: PATH,
    content: "on disk",
    contentHash: BASE,
    revision: 4,
  });
  return reduceDraft(state, { kind: "edited", path: PATH, draft });
}

const entry = (state: DraftState) => state.entries[PATH]!;

describe("draft store", () => {
  it("opens a file clean and marks it edited once the text differs", () => {
    const state = openDraft({ entries: {} }, { path: PATH, content: "on disk", contentHash: BASE, revision: 4 });
    expect(entry(state)).toMatchObject({
      path: PATH, baseHash: BASE, baseRevision: 4, draft: "on disk",
      incomingStatus: "idle", incoming: null, resolution: "editing",
    });
    expect(saveDisabled(entry(state))).toBe(false);
    expect(entry(reduceDraft(state, { kind: "edited", path: PATH, draft: "typed" })).draft).toBe("typed");
  });

  it("disables save the moment an event touches the path, before any fetch runs", () => {
    const state = reduceDraft(opened(), { kind: "external", paths: [PATH], seq: 9 });
    expect(entry(state)).toMatchObject({
      incomingStatus: "loading", incomingGeneration: 9, resolution: "conflicted", incoming: null,
    });
    // Nothing has been fetched yet, so saving now would overwrite an unread change.
    expect(saveDisabled(entry(state))).toBe(true);
  });

  it("accepts a fetch only while its generation is the latest one", () => {
    let state = reduceDraft(opened(), { kind: "external", paths: [PATH], seq: 9 });
    state = reduceDraft(state, { kind: "external", paths: [PATH], seq: 11 });
    const stale = reduceDraft(state, {
      kind: "incoming", path: PATH, generation: 9, content: "old outside", contentHash: NEXT, revision: 5,
    });
    expect(entry(stale)).toMatchObject({ incomingStatus: "loading", incoming: null, incomingGeneration: 11 });

    const fresh = reduceDraft(state, {
      kind: "incoming", path: PATH, generation: 11, content: "new outside", contentHash: THIRD, revision: 6,
    });
    expect(entry(fresh)).toMatchObject({
      incomingStatus: "ready",
      incoming: { content: "new outside", hash: THIRD, revision: 6 },
      resolution: "conflicted",
    });
    expect(saveDisabled(entry(fresh))).toBe(true);
  });

  it("keeps the draft by rebasing onto the incoming version so the next save lands", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 9 });
    state = reduceDraft(state, {
      kind: "incoming", path: PATH, generation: 9, content: "theirs", contentHash: NEXT, revision: 5,
    });
    const kept = reduceDraft(state, { kind: "keep", path: PATH });
    expect(entry(kept)).toMatchObject({
      draft: "mine", baseHash: NEXT, baseRevision: 5, resolution: "resolved-keep", incomingStatus: "idle",
    });
    // Keeping something you then cannot save is a dead end, so save is enabled again.
    expect(saveDisabled(entry(kept))).toBe(false);
  });

  it("takes the incoming version, and reopens the conflict if another event arrives after keep", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 9 });
    state = reduceDraft(state, {
      kind: "incoming", path: PATH, generation: 9, content: "theirs", contentHash: NEXT, revision: 5,
    });
    const taken = reduceDraft(state, { kind: "take", path: PATH });
    expect(entry(taken)).toMatchObject({
      draft: "theirs", baseHash: NEXT, baseRevision: 5, resolution: "resolved-take", incoming: null,
    });

    const again = reduceDraft(reduceDraft(state, { kind: "keep", path: PATH }), {
      kind: "external", paths: [PATH], seq: 12,
    });
    expect(entry(again)).toMatchObject({ resolution: "conflicted", incomingStatus: "loading", incomingGeneration: 12 });
    expect(saveDisabled(entry(again))).toBe(true);
  });

  it("holds the conflict open while comparing, and keeps both texts available", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 9 });
    state = reduceDraft(state, {
      kind: "incoming", path: PATH, generation: 9, content: "theirs", contentHash: NEXT, revision: 5,
    });
    const comparing = reduceDraft(state, { kind: "compare", path: PATH });
    expect(entry(comparing)).toMatchObject({
      resolution: "conflicted", draft: "mine", incoming: { content: "theirs" }, incomingStatus: "ready",
    });
    expect(saveDisabled(entry(comparing))).toBe(true);
  });

  it("treats a file deleted outside as content null, and recreates it on the next save", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 9 });
    state = reduceDraft(state, { kind: "incoming", path: PATH, generation: 9, content: null, contentHash: null, revision: 5 });
    expect(entry(state)).toMatchObject({ incomingStatus: "ready", incoming: { content: null, hash: null } });
    const kept = reduceDraft(state, { kind: "keep", path: PATH });
    // No file to expect: the save recreates it rather than failing a precondition.
    expect(entry(kept)).toMatchObject({ baseHash: null, draft: "mine", resolution: "resolved-keep" });
  });

  it("keeps save disabled when the fetch fails, without falling back to the old base", () => {
    let state = reduceDraft(opened(), { kind: "external", paths: [PATH], seq: 9 });
    state = reduceDraft(state, { kind: "incoming-failed", path: PATH, generation: 9 });
    expect(entry(state)).toMatchObject({ incomingStatus: "failed", incoming: null, resolution: "conflicted" });
    expect(saveDisabled(entry(state))).toBe(true);
    // A retry starts the same gate again rather than clearing it.
    expect(entry(reduceDraft(state, { kind: "retry", path: PATH })).incomingStatus).toBe("loading");
  });

  it("coalesces the studio's own save event and refuses to clear a newer one", () => {
    const state = reduceDraft(opened("mine"), { kind: "saved", path: PATH, contentHash: NEXT, revision: 5, changeSeq: 20 });
    expect(entry(state)).toMatchObject({
      baseHash: NEXT, baseRevision: 5, acknowledgedChangeSeq: 20, resolution: "editing", incomingStatus: "idle",
    });
    // The SSE echo of this very save is not a conflict with itself.
    const echo = reduceDraft(state, { kind: "external", paths: [PATH], seq: 20 });
    expect(entry(echo)).toMatchObject({ resolution: "editing", incomingStatus: "idle" });
    // Someone else's write after the save still is one.
    expect(entry(reduceDraft(state, { kind: "external", paths: [PATH], seq: 21 }))).toMatchObject({
      resolution: "conflicted", incomingStatus: "loading",
    });
  });

  it("does not let a save response settle a conflict that is newer than it", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 30 });
    // Response A comes back after event B: A must not clear B's conflict.
    state = reduceDraft(state, { kind: "saved", path: PATH, contentHash: NEXT, revision: 5, changeSeq: 25 });
    expect(entry(state)).toMatchObject({
      resolution: "conflicted", incomingStatus: "loading", incomingGeneration: 30, acknowledgedChangeSeq: 25,
    });
    expect(saveDisabled(entry(state))).toBe(true);
  });

  it("updates the base from a no-op save without acknowledging or clearing an incoming change", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 30 });
    state = reduceDraft(state, { kind: "saved", path: PATH, contentHash: NEXT, revision: 5, changeSeq: null });
    expect(entry(state)).toMatchObject({
      baseHash: NEXT, baseRevision: 5, acknowledgedChangeSeq: 0,
      resolution: "conflicted", incomingStatus: "loading",
    });
  });

  it("refetches every open draft after an event-stream gap", () => {
    const other = "compositions/scene-2.html";
    let state = openDraft(opened("mine"), { path: other, content: "b", contentHash: NEXT, revision: 4 });
    state = reduceDraft(state, { kind: "resynced", seq: 41 });
    for (const path of [PATH, other]) {
      expect(state.entries[path]).toMatchObject({
        incomingStatus: "loading", incomingGeneration: 41, resolution: "conflicted",
      });
      expect(saveDisabled(state.entries[path]!)).toBe(true);
    }
  });

  it("matches changed paths by whole segments, including a renamed parent directory", () => {
    const state = openDraft(opened(), { path: "compositions/deep/scene-9.html", content: "x", contentHash: NEXT, revision: 4 });
    expect(conflicts(state, ["compositions/scene-1.html"])).toEqual([PATH]);
    // A parent directory covers everything under it…
    expect(new Set(conflicts(state, ["compositions"]))).toEqual(new Set([PATH, "compositions/deep/scene-9.html"]));
    // …but a common prefix that is not a whole segment covers nothing.
    expect(conflicts(state, ["composition"])).toEqual([]);
    expect(conflicts(state, ["compositions/scene-1.html.bak"])).toEqual([]);
  });

  it("closes a draft only through an explicit discard", () => {
    const state = reduceDraft(opened("mine"), { kind: "discarded", path: PATH });
    expect(state.entries[PATH]).toBeUndefined();
  });

  it("refuses a save while the newest read is still in flight or has failed", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 9 });
    expect(saveDisabled(entry(state))).toBe(true);
    state = reduceDraft(state, { kind: "incoming-failed", path: PATH, generation: 9 });
    expect(saveDisabled(entry(state))).toBe(true);
    // Only a resolution reopens saving — never the passage of time.
    state = reduceDraft(state, { kind: "retry", path: PATH });
    state = reduceDraft(state, { kind: "incoming", path: PATH, generation: 9, content: "theirs", contentHash: NEXT, revision: 5 });
    expect(saveDisabled(entry(reduceDraft(state, { kind: "keep", path: PATH })))).toBe(false);
  });

  it("ignores an event older than one it already reacted to", () => {
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 12 });
    state = reduceDraft(state, { kind: "external", paths: [PATH], seq: 7 });
    expect(entry(state).incomingGeneration).toBe(12);
  });

  it("never rewrites the draft text on its own", () => {
    // Every path that replaces the text is a choice the user made: take, or
    // reverting. An arriving change is not one of them.
    let state = reduceDraft(opened("mine"), { kind: "external", paths: [PATH], seq: 9 });
    state = reduceDraft(state, { kind: "incoming", path: PATH, generation: 9, content: "theirs", contentHash: NEXT, revision: 5 });
    expect(entry(state).draft).toBe("mine");
    expect(entry(reduceDraft(state, { kind: "compare", path: PATH })).draft).toBe("mine");
    expect(entry(reduceDraft(state, { kind: "keep", path: PATH })).draft).toBe("mine");
  });
});
