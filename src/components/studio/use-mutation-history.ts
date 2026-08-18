"use client";

import * as React from "react";

import { fetchApi } from "@/lib/api/services";
import type { BrowserHistoryState, HistoryDirection } from "@/lib/studio/history-controls";
import { historyPath } from "@/lib/studio/studio-session";
import { useStudioSession } from "./studio-session-context";

const EMPTY_HISTORY: BrowserHistoryState = {
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

async function payload<Value>(response: Response): Promise<Value> {
  const body = await response.json().catch(() => null) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `history request failed (${response.status})`);
  return body as Value;
}

export function useMutationHistory(projectId: string, onProjectChanged: () => void) {
  const studio = useStudioSession();
  const [state, setState] = React.useState<BrowserHistoryState>(EMPTY_HISTORY);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const response = await fetchApi(
      historyPath(projectId, "history"),
      studio.request({ cache: "no-store" }),
    );
    setState(await payload<BrowserHistoryState>(response));
  }, [projectId, studio]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not read history."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, studio.eventRevision]);

  const apply = React.useCallback(async (direction: HistoryDirection) => {
    setError(null);
    setState((current) => ({ ...current, busy: true }));
    try {
      const response = await fetchApi(
        historyPath(projectId, direction),
        studio.request({ method: "POST" }),
      );
      const result = await payload<{ state: BrowserHistoryState }>(response);
      setState(result.state);
      onProjectChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${direction}.`);
      await load().catch(() => setState((current) => ({ ...current, busy: false })));
    }
  }, [load, onProjectChanged, projectId, studio]);

  const escape = React.useCallback(async (reloadSource: boolean) => {
    setError(null);
    try {
      await studio.resetHistory(reloadSource);
      setState(EMPTY_HISTORY);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset history.");
    }
  }, [studio]);

  return {
    state,
    error,
    undo: () => void apply("undo"),
    redo: () => void apply("redo"),
    reloadSource: () => void escape(true),
    keepCurrent: () => void escape(false),
  };
}
