"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { toPercent } from "@/lib/studio/format";
import type { TimelineSection } from "@/lib/studio/types";
import { TIMELINE_GUTTER } from "./timeline-constants";
import { TimelineRuler } from "./timeline-ruler";
import { TimelineToolbar } from "./timeline-toolbar";
import { TimelineTrack } from "./timeline-track";

const ZOOM_STEPS = ["Fit", "1x", "2x", "4x"];

export function Timeline({
  sections,
  duration,
  currentTime,
  onScrub,
}: {
  sections: TimelineSection[];
  duration: number;
  currentTime: number;
  onScrub: (seconds: number) => void;
}) {
  const [zoomStep, setZoomStep] = React.useState(0);
  const [hidden, setHidden] = React.useState<string[]>([]);

  const toggleVisible = (trackId: string) =>
    setHidden((current) =>
      current.includes(trackId)
        ? current.filter((id) => id !== trackId)
        : [...current, trackId],
    );

  return (
    <div className="bg-sidebar flex h-full flex-col">
      <TimelineToolbar
        zoomLabel={ZOOM_STEPS[zoomStep]}
        onFit={() => setZoomStep(0)}
        onZoomIn={() =>
          setZoomStep((step) => Math.min(step + 1, ZOOM_STEPS.length - 1))
        }
        onZoomOut={() => setZoomStep((step) => Math.max(step - 1, 0))}
      />

      <div className="relative min-h-0 flex-1 overflow-auto">
        <TimelineRuler
          duration={duration}
          currentTime={currentTime}
          onScrub={onScrub}
        />

        {sections.map((section) => (
          <div key={section.id}>
            <div className="flex h-6 shrink-0 items-center border-b">
              <div className={cn(TIMELINE_GUTTER, "shrink-0 border-r")} />
              <div className="relative grow">
                <span className="px-1.5 font-mono text-[10px] tracking-wide">
                  {section.label}
                </span>
                <span
                  className="bg-studio-accent absolute inset-y-0 z-10 w-px"
                  style={{ left: toPercent(currentTime, duration) }}
                />
              </div>
            </div>

            {section.tracks.map((track) => (
              <TimelineTrack
                key={track.id}
                track={{ ...track, visible: !hidden.includes(track.id) }}
                duration={duration}
                currentTime={currentTime}
                onToggleVisible={toggleVisible}
              />
            ))}
          </div>
        ))}

        {sections.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">
            No timeline elements found in this composition.
          </p>
        ) : null}
      </div>
    </div>
  );
}
