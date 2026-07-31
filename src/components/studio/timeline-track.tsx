"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { toPercent } from "@/lib/studio/format";
import type { TimelineTrack as TimelineTrackModel } from "@/lib/studio/types";
import { TIMELINE_GUTTER } from "./timeline-constants";

export function TimelineTrack({
  track,
  duration,
  currentTime,
  onToggleVisible,
}: {
  track: TimelineTrackModel;
  duration: number;
  currentTime: number;
  onToggleVisible: (trackId: string) => void;
}) {
  const Icon = track.visible ? EyeIcon : EyeOffIcon;

  return (
    <div className="flex h-11 shrink-0 border-b">
      <div
        className={cn(
          TIMELINE_GUTTER,
          "flex shrink-0 items-center justify-center border-r",
        )}
      >
        <button
          type="button"
          onClick={() => onToggleVisible(track.id)}
          aria-label={`Toggle ${track.label}`}
          aria-pressed={track.visible}
          className="text-muted-foreground hover:text-foreground rounded-sm p-1"
        >
          <Icon className="size-3.5" />
        </button>
      </div>

      <div className="relative grow px-px py-1.5">
        {track.clips.map((clip) => (
          <div
            key={clip.id}
            className={cn(
              "absolute inset-y-1.5 flex items-center overflow-hidden rounded-sm border px-1.5",
              track.visible
                ? "bg-muted-foreground/25"
                : "bg-muted-foreground/10 opacity-60",
            )}
            style={{
              left: toPercent(clip.start, duration),
              width: toPercent(clip.end - clip.start, duration),
            }}
          >
            <span className="text-foreground/80 truncate font-mono text-[10px]">
              {clip.label}
            </span>
          </div>
        ))}

        <span
          className="bg-studio-accent absolute inset-y-0 z-10 w-px"
          style={{ left: toPercent(currentTime, duration) }}
        />
      </div>
    </div>
  );
}
