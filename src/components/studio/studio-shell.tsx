"use client";

import * as React from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { sceneSettings, type PreviewSettings } from "@/lib/studio/preview-settings";
import { orderedScenes } from "@/lib/studio/scene-order";
import type { FileNode, RootTrack, Scene, SourceFile } from "@/lib/studio/types";
import { PlayerTimeProvider } from "./player-time";
import { PreviewPanel } from "./preview-panel";
import { SourcePane } from "./source-pane";
import { useHyperframesPlayer } from "./use-hyperframes-player";
import { usePreviewSettings } from "./use-preview-settings";

export function StudioShell({
  projectId,
  projectSlug,
  previewUrl,
  aspectRatio,
  authoredDuration,
  tree,
  files,
  scenes,
  rootTrack,
  previewSettings,
  previewSettingsRevision,
  onRefresh,
}: {
  projectId: string;
  projectSlug: string;
  previewUrl: string;
  aspectRatio: number;
  authoredDuration: number | null;
  tree: FileNode[];
  files: SourceFile[];
  scenes: Scene[];
  rootTrack: RootTrack | null;
  previewSettings: PreviewSettings;
  previewSettingsRevision: number;
  onRefresh: () => Promise<void>;
}) {
  // Bumped after a scene edit: it changes the player's src, which remounts the
  // player against the rewritten composition instead of the stale iframe.
  const [revision, setRevision] = React.useState(0);

  // The player lives here, not in the preview pane: the Scene tab on the left
  // seeks it too, and both sides need the same currentTime.
  const { containerRef, state, controls, timeStore } = useHyperframesPlayer(
    revision === 0 ? previewUrl : `${previewUrl}?r=${revision}`,
  );
  const duration = state.duration || authoredDuration || 0;

  // A source edit changes what the scenes *are*, so the page has to be re-read.
  const handleProjectChanged = React.useCallback(() => {
    setRevision((current) => current + 1);
    void onRefresh();
  }, [onRefresh]);

  // A preview-settings edit does not: the values are baked into the preview
  // document, so the player has to reload, but the scenes, the file tree and
  // the root track on the server are untouched. Refreshing them too meant a
  // full re-parse of the project behind every colour change.
  const rebuildPreview = React.useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  const preview = usePreviewSettings(
    projectId,
    previewSettings,
    previewSettingsRevision,
    rebuildPreview,
  );

  // Selection is shared, not per-pane: clicking a storyboard card and clicking a
  // timeline lane are the same act, and both panes highlight the result.
  const [requestedId, setSelectedId] = React.useState("");
  const selectScene = React.useCallback(
    (scene: Scene) => {
      setSelectedId(scene.id);
      controls.seek(scene.start);
    },
    [controls],
  );

  // Resolved against the scenes that actually exist, so a scene renamed or
  // removed by an agent edit falls back to the first beat in both panes at once
  // instead of leaving the timeline with nothing highlighted while the detail
  // panel shows something else.
  const ordered = orderedScenes(scenes);
  const selectedId =
    ordered.find(({ scene }) => scene.id === requestedId)?.scene.id ??
    ordered[0]?.scene.id ??
    "";

  // Stable so the memoized lanes and cards below only re-render when their own
  // scene changes, not whenever this shell does.
  const toggleHidden = React.useCallback(
    (scene: Scene) =>
      preview.patchScene(scene.id, {
        hidden: !sceneSettings(preview.settings, scene.id).hidden,
      }),
    [preview],
  );

  return (
    <PlayerTimeProvider store={timeStore}>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="38" minSize="20">
          <SourcePane
            projectId={projectId}
            projectSlug={projectSlug}
            tree={tree}
            files={files}
            scenes={scenes}
            preview={preview}
            selectedId={selectedId}
            onSeek={controls.seek}
            onSelectScene={selectScene}
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
            scenes={scenes}
            rootTrack={rootTrack}
            settings={preview.settings}
            selectedId={selectedId}
            onSelectScene={selectScene}
            onToggleHidden={toggleHidden}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </PlayerTimeProvider>
  );
}
