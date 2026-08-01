"use client";

import type * as React from "react";

import { formatTimecode } from "@/lib/studio/format";
import { Playhead } from "./player-time";
import { TIMELINE_GUTTER_STYLE } from "./timeline-constants";

/** Coarsest tick that still keeps labels ~70px apart at the current zoom. */
function tickInterval(pixelsPerSecond: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60];
  return (
    candidates.find((step) => step * pixelsPerSecond >= 70) ??
    candidates[candidates.length - 1]
  );
}

export function TimelineRuler({
  duration,
  pixelsPerSecond,
  onScrub,
}: {
  duration: number;
  pixelsPerSecond: number;
  onScrub: (seconds: number) => void;
}) {
  const interval = tickInterval(pixelsPerSecond || 1);
  const ticks = Array.from(
    { length: Math.floor((duration || 0) / interval) + 1 },
    (_, index) => index * interval,
  );

  // Pointer capture rather than a click handler: dragging along the ruler has
  // to keep scrubbing even once the pointer leaves the strip vertically.
  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const { left } = event.currentTarget.getBoundingClientRect();
    if (duration <= 0 || pixelsPerSecond <= 0) return;
    const seconds = (event.clientX - left) / pixelsPerSecond;
    onScrub(Math.min(Math.max(seconds, 0), duration));
  };

  return (
    <div className="bg-sidebar sticky top-0 z-30 flex h-6 shrink-0 border-b">
      <div
        style={TIMELINE_GUTTER_STYLE}
        className="bg-sidebar sticky left-0 z-10 shrink-0 border-r"
      />
      <div
        className="relative shrink-0 cursor-ew-resize touch-none"
        style={{ width: duration * pixelsPerSecond }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          scrub(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons !== 1) return;
          scrub(event);
        }}
      >
        {ticks.map((tick) => (
          <span
            key={tick}
            className="text-muted-foreground pointer-events-none absolute top-0 h-full border-l pt-0.5 pl-1 font-mono text-[10px] leading-none"
            style={{ left: tick * pixelsPerSecond }}
          >
            {formatTimecode(tick)}
          </span>
        ))}
        <Playhead
          pixelsPerSecond={pixelsPerSecond}
          className="bg-studio-accent pointer-events-none absolute -top-px z-10 size-2"
          transform="translateX(-50%) rotate(45deg)"
        />
      </div>
    </div>
  );
}
