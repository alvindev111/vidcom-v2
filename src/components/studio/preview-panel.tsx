"use client";

import type * as React from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { TimelineSection } from "@/lib/studio/types";
import { PlaybackBar } from "./playback-bar";
import { PreviewCanvas } from "./preview-canvas";
import { Timeline } from "./timeline";
import type { PlayerControls, PlayerState } from "./use-hyperframes-player";

export function PreviewPanel({
  containerRef,
  aspectRatio,
  duration,
  state,
  controls,
  sections,
}: {
  containerRef: React.Ref<HTMLDivElement>;
  aspectRatio: number;
  duration: number;
  state: PlayerState;
  controls: PlayerControls;
  sections: TimelineSection[];
}) {
  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="62" minSize="30">
        <div className="flex h-full flex-col">
          <PreviewCanvas
            containerRef={containerRef}
            aspectRatio={aspectRatio}
            ready={state.ready}
            error={state.error}
          />
          <PlaybackBar
            duration={duration}
            currentTime={state.currentTime}
            paused={state.paused}
            muted={state.muted}
            playbackRate={state.playbackRate}
            disabled={!state.ready}
            onToggle={controls.toggle}
            onSeek={controls.seek}
            onToggleMuted={controls.toggleMuted}
            onPlaybackRateChange={controls.setPlaybackRate}
          />
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="38" minSize="15">
        <Timeline
          sections={sections}
          duration={duration}
          currentTime={state.currentTime}
          onScrub={controls.seek}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
