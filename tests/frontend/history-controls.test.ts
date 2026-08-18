import { describe, expect, it } from "vitest";

import {
  historyDirectionView,
  type BrowserHistoryState,
} from "../../src/lib/studio/history-controls";

const empty: BrowserHistoryState = {
  canUndo: false,
  canRedo: false,
  busy: false,
  depth: 0,
  nextUndoLabel: null,
  nextRedoLabel: null,
  undoBlocked: false,
  redoBlocked: false,
  undoBlockedReason: null,
  redoBlockedReason: null,
};

describe("history control view model", () => {
  it("shows the server-owned label for the operation that will be applied", () => {
    expect(historyDirectionView({ ...empty, canUndo: true, nextUndoLabel: "Edit source" }, "undo"))
      .toEqual({ disabled: false, label: "Undo Edit source", blockedMessage: null });
    expect(historyDirectionView({ ...empty, canRedo: true, nextRedoLabel: "Create scene" }, "redo"))
      .toEqual({ disabled: false, label: "Redo Create scene", blockedMessage: null });
  });

  it("disables both directions while one reservation is busy", () => {
    expect(historyDirectionView({ ...empty, canUndo: true, busy: true }, "undo").disabled).toBe(true);
  });

  it("turns stable barrier reasons into an actionable message", () => {
    expect(historyDirectionView({
      ...empty,
      undoBlocked: true,
      undoBlockedReason: "source-changed-externally",
    }, "undo")).toEqual({
      disabled: true,
      label: "Undo",
      blockedMessage: "Source changed outside this studio.",
    });
    expect(historyDirectionView({
      ...empty,
      redoBlocked: true,
      redoBlockedReason: "history-desync",
    }, "redo").blockedMessage).toBe("History lost synchronization with the project.");
  });
});
