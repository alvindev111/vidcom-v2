"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type {
  FileNode,
  Scene,
  SourceFile,
  TimelineSection,
} from "@/lib/studio/types";
import { PreviewPanel } from "./preview-panel";
import { SourcePane } from "./source-pane";
import { useHyperframesPlayer } from "./use-hyperframes-player";

export function StudioShell({
  projectSlug,
  previewUrl,
  aspectRatio,
  authoredDuration,
  tree,
  files,
  sections,
  scenes,
}: {
  projectSlug: string;
  previewUrl: string;
  aspectRatio: number;
  authoredDuration: number | null;
  tree: FileNode[];
  files: SourceFile[];
  sections: TimelineSection[];
  scenes: Scene[];
}) {
  const router = useRouter();
  // Bumped after a scene edit: it changes the player's src, which remounts the
  // player against the rewritten composition instead of the stale iframe.
  const [revision, setRevision] = React.useState(0);

  // The player lives here, not in the preview pane: the Scene tab on the left
  // seeks it too, and both sides need the same currentTime.
  const { containerRef, state, controls } = useHyperframesPlayer(
    revision === 0 ? previewUrl : `${previewUrl}?r=${revision}`,
  );
  const duration = state.duration || authoredDuration || 0;

  const handleProjectChanged = React.useCallback(() => {
    setRevision((current) => current + 1);
    router.refresh();
  }, [router]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize="38" minSize="20">
        <SourcePane
          projectSlug={projectSlug}
          tree={tree}
          files={files}
          scenes={scenes}
          currentTime={state.currentTime}
          onSeek={controls.seek}
          onProjectChanged={handleProjectChanged}
        />
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel defaultSize="62" minSize="25">
        <PreviewPanel
          containerRef={containerRef}
          aspectRatio={aspectRatio}
          duration={duration}
          state={state}
          controls={controls}
          sections={sections}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
