"use client";

import { ZoomInIcon, ZoomOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TimeReadout } from "./player-time";

export function TimelineToolbar({
  zoom,
  canZoomIn,
  canZoomOut,
  sceneCount,
  selectedLabel,
  onFit,
  onZoomIn,
  onZoomOut,
}: {
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
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
      <span className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
        Timeline · {sceneCount}
      </span>

      {selectedLabel ? (
        <span className="text-studio-accent min-w-0 truncate font-mono text-[10px]">
          {selectedLabel}
        </span>
      ) : null}

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
  );
}
