"use client";

import { Redo2Icon, Undo2Icon, ZoomInIcon, ZoomOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { historyDirectionView } from "@/lib/studio/history-controls";
import { TimeReadout } from "./player-time";
import type { useMutationHistory } from "./use-mutation-history";

export function TimelineToolbar({
  history,
  zoom,
  canZoomIn,
  canZoomOut,
  sceneCount,
  selectedLabel,
  onFit,
  onZoomIn,
  onZoomOut,
}: {
  history: ReturnType<typeof useMutationHistory>;
  /** Multiplier over the width that fits the whole composition. */
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  sceneCount: number;
  /** Scene under the playhead, echoed so the two panes read as one selection. */
  selectedLabel: string | null;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  const undo = historyDirectionView(history.state, "undo");
  const redo = historyDirectionView(history.state, "redo");
  const blockedMessage = undo.blockedMessage ?? redo.blockedMessage;
  return (
    <div className="shrink-0 border-b">
      <div className="flex h-8 items-center gap-2 px-2">
      <span className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
        Timeline · {sceneCount}
      </span>

      {selectedLabel ? (
        <span className="text-studio-accent min-w-0 truncate font-mono text-[10px]">
          {selectedLabel}
        </span>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="h-6 max-w-40 shrink-0 gap-1 px-2 text-[10px]"
        title={undo.label}
        aria-label={undo.label}
        disabled={undo.disabled}
        onClick={history.undo}
      >
        <Undo2Icon className="size-3" />
        <span className="truncate">{undo.label}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 max-w-40 shrink-0 gap-1 px-2 text-[10px]"
        title={redo.label}
        aria-label={redo.label}
        disabled={redo.disabled}
        onClick={history.redo}
      >
        <Redo2Icon className="size-3" />
        <span className="truncate">{redo.label}</span>
      </Button>

      <TimeReadout className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]" />

      <Button
        variant={zoom === 1 ? "secondary" : "ghost"}
        size="sm"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={onFit}
      >
        Fit
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label="Zoom out"
        disabled={!canZoomOut}
        onClick={onZoomOut}
      >
        <ZoomOutIcon className="size-3.5" />
      </Button>
      <span className="text-muted-foreground w-8 shrink-0 text-center font-mono text-xs">
        {zoom}x
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label="Zoom in"
        disabled={!canZoomIn}
        onClick={onZoomIn}
      >
        <ZoomInIcon className="size-3.5" />
      </Button>
      </div>
      {blockedMessage ? (
        <div className="border-t border-amber-500/30 bg-amber-500/10 px-2 py-1" role="alert">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[10px] text-amber-700 dark:text-amber-300">
              {blockedMessage}
            </span>
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={history.reloadSource}>
              Reload source
            </Button>
            <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={history.keepCurrent}>
              Keep current
            </Button>
          </div>
        </div>
      ) : history.error ? (
        <p className="text-destructive px-2 py-1 text-[10px]" role="alert">{history.error}</p>
      ) : null}
    </div>
  );
}
