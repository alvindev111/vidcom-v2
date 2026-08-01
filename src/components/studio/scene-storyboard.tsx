"use client";

import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon, CameraIcon } from "lucide-react";

import {
  sceneSettings,
  type PreviewSettings,
} from "@/lib/studio/preview-settings";
import { splitScenes, type OrderedScene } from "@/lib/studio/scene-order";
import type { FileNode, Scene } from "@/lib/studio/types";
import { collectFrames, frameForScene } from "@/lib/studio/snapshots";
import { useLiveScenes } from "./player-time";
import { SceneCard } from "./scene-card";

/**
 * Storyboard of the composition: content scenes in playback order, with the
 * overlay and transition layers folded away so the shelf reads as the video's
 * beats rather than as a list of every composition host.
 */
export function SceneStoryboard({
  projectSlug,
  scenes,
  tree,
  settings,
  selectedId,
  onSelect,
}: {
  projectSlug: string;
  scenes: Scene[];
  tree: FileNode[];
  settings: PreviewSettings;
  selectedId: string;
  onSelect: (scene: Scene) => void;
}) {
  const [showLayers, setShowLayers] = React.useState(false);
  const frames = React.useMemo(() => collectFrames(tree), [tree]);
  const liveScenes = useLiveScenes(scenes);

  // Shared with the timeline so a card and a lane carry the same number.
  const { content: contentScenes, layers } = splitScenes(scenes);
  const missingFrames = contentScenes.filter(
    ({ scene }) => frameForScene(frames, scene) === null,
  ).length;

  const card = ({ scene, index }: OrderedScene) => (
    <SceneCard
      key={scene.id}
      scene={scene}
      index={index}
      frame={frameForScene(frames, scene)}
      projectSlug={projectSlug}
      selected={scene.id === selectedId}
      live={liveScenes.has(scene.id)}
      hidden={sceneSettings(settings, scene.id).hidden}
      onSelect={onSelect}
    />
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        <span className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
          Storyboard · {contentScenes.length}
        </span>
        {missingFrames > 0 ? (
          <span className="text-muted-foreground ml-auto flex items-center gap-1.5 font-mono text-[10px]">
            <CameraIcon className="size-3" />
            {missingFrames} without a frame — run{" "}
            <code>hyperframes snapshot</code>
          </span>
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
        {contentScenes.map(card)}
      </div>

      {contentScenes.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No content scenes yet — ask the agent in the AI Composer tab to add
          one.
        </p>
      ) : null}

      {layers.length > 0 ? (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowLayers((value) => !value)}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium tracking-widest uppercase"
          >
            {showLayers ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
            Overlays & transitions · {layers.length}
          </button>

          {showLayers ? (
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
              {layers.map(card)}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
