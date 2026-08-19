"use client";

import type * as React from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { PreviewSettings } from "@/lib/studio/preview-settings";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import type { RootTrack, Scene } from "@/lib/studio/types";
import { PlaybackBar } from "./playback-bar";
import { PreviewCanvas } from "./preview-canvas";
import { Timeline } from "./timeline";
import type { PlayerControls, PlayerState } from "./use-hyperframes-player";

export function PreviewPanel({
  projectId,
  containerRef,
  aspectRatio,
  duration,
  frameRate,
  entryContentHash,
  projectRevision,
  state,
  controls,
  scenes,
  rootTrack,
  settings,
  selectedId,
  onSelectScene,
  onToggleHidden,
  onProjectChanged,
}: {
  projectId: string;
  containerRef: React.Ref<HTMLDivElement>;
  aspectRatio: number;
  duration: number;
  frameRate: number;
  entryContentHash: string | null;
  projectRevision: number;
  state: PlayerState;
  controls: PlayerControls;
  scenes: Scene[];
  rootTrack: RootTrack | null;
  settings: PreviewSettings;
  selectedId: string;
  onSelectScene: (scene: Scene) => void;
  onToggleHidden: (scene: Scene) => void;
  onProjectChanged: ProjectChanged;
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
            frameRate={frameRate}
            duration={duration}
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
          projectId={projectId}
          scenes={scenes}
          rootTrack={rootTrack}
          settings={settings}
          duration={duration}
          frameRate={frameRate}
          entryContentHash={entryContentHash}
          projectRevision={projectRevision}
          selectedId={selectedId}
          onScrub={controls.seek}
          onTogglePlay={controls.toggle}
          onSelect={onSelectScene}
          onToggleHidden={onToggleHidden}
          onProjectChanged={onProjectChanged}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
