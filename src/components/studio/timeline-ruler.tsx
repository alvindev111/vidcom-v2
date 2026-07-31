"use client";

import type * as React from "react";

import { formatTimecode, toPercent } from "@/lib/studio/format";
import { TIMELINE_GUTTER } from "./timeline-constants";

/** Aim for a tick every ~90px of lane width without fractional seconds. */
function tickInterval(duration: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60];
  return candidates.find((step) => duration / step <= 12) ?? 60;
}

export function TimelineRuler({
  duration,
  currentTime,
  onScrub,
}: {
  duration: number;
  currentTime: number;
  onScrub: (seconds: number) => void;
}) {
  const interval = tickInterval(duration || 1);
  const ticks = Array.from(
    { length: Math.floor((duration || 0) / interval) + 1 },
    (_, index) => index * interval,
  );

  const scrubTo = (event: React.MouseEvent<HTMLDivElement>) => {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    if (width <= 0 || duration <= 0) return;
    const fraction = Math.min(Math.max((event.clientX - left) / width, 0), 1);
    onScrub(fraction * duration);
  };

  return (
    <div className="bg-sidebar sticky top-0 z-20 flex h-6 shrink-0 border-b">
      <div className={`${TIMELINE_GUTTER} shrink-0 border-r`} />
      <div className="relative grow cursor-pointer" onClick={scrubTo}>
        {ticks.map((tick) => (
          <span
            key={tick}
            className="text-muted-foreground absolute top-0 h-full border-l pt-0.5 pl-1 font-mono text-[10px] leading-none"
            style={{ left: toPercent(tick, duration) }}
          >
            {formatTimecode(tick)}
          </span>
        ))}
        <span
          className="bg-studio-accent absolute -top-px z-10 size-2 -translate-x-1/2 rotate-45"
          style={{ left: toPercent(currentTime, duration) }}
        />
      </div>
    </div>
  );
}
