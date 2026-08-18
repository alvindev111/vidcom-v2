export interface BrowserHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  depth: number;
  nextUndoLabel: string | null;
  nextRedoLabel: string | null;
  undoBlocked: boolean;
  redoBlocked: boolean;
  undoBlockedReason: string | null;
  redoBlockedReason: string | null;
}

export type HistoryDirection = "undo" | "redo";

const BLOCK_MESSAGES: Record<string, string> = {
  "source-changed-externally": "Source changed outside this studio.",
  "history-desync": "History lost synchronization with the project.",
};

export function historyDirectionView(state: BrowserHistoryState, direction: HistoryDirection) {
  const title = direction === "undo" ? "Undo" : "Redo";
  const available = direction === "undo" ? state.canUndo : state.canRedo;
  const blocked = direction === "undo" ? state.undoBlocked : state.redoBlocked;
  const reason = direction === "undo" ? state.undoBlockedReason : state.redoBlockedReason;
  const operation = direction === "undo" ? state.nextUndoLabel : state.nextRedoLabel;
  return {
    disabled: state.busy || blocked || !available,
    label: operation ? `${title} ${operation}` : title,
    blockedMessage: blocked ? (BLOCK_MESSAGES[reason ?? ""] ?? "History is blocked by a project change.") : null,
  };
}
