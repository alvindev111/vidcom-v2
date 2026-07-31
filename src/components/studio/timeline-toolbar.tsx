"use client";

import { ChevronDownIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function TimelineToolbar({
  zoomLabel,
  onFit,
  onZoomIn,
  onZoomOut,
}: {
  zoomLabel: string;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b px-2">
      <Button
        variant="secondary"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={onFit}
      >
        Fit
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Zoom out"
        onClick={onZoomOut}
      >
        <ZoomOutIcon className="size-3.5" />
      </Button>
      <span className="text-muted-foreground w-8 text-center font-mono text-xs">
        {zoomLabel}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Zoom in"
        onClick={onZoomIn}
      >
        <ZoomInIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Collapse timeline"
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
    </div>
  );
}
