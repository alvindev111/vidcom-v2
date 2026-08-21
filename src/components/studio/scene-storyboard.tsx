"use client";

import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import {
  sceneSettings,
  type PreviewSettings,
} from "@/lib/studio/preview-settings";
import { splitScenes, type OrderedScene } from "@/lib/studio/scene-order";
import { keyboardReorderIntent, reorderDropIntent } from "@/lib/studio/scene-order";
import { saveSceneReorder } from "@/lib/studio/scene-order-mutation";
import { selectClip } from "@/lib/studio/editor-interaction";
import { fetchApi } from "@/lib/api/services";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import { mutationChangeSeq } from "@/lib/studio/preview-reload";
import type { Scene } from "@/lib/studio/types";
import { useLiveScenes } from "./player-time";
import { SceneCard } from "./scene-card";
import { useEditorInteraction } from "./editor-interaction-context";
import { useStudioSession } from "./studio-session-context";

/**
 * Storyboard of the composition: content scenes in playback order, with the
 * overlay and transition layers folded away so the shelf reads as the video's
 * beats rather than as a list of every composition host.
 */
export function SceneStoryboard({
  projectId,
  scenes,
  projectRevision,
  frameRate,
  settings,
  selectedId,
  onSelect,
  entryContentHash,
  onProjectChanged,
}: {
  projectId: string;
  scenes: Scene[];
  projectRevision: number;
  frameRate: number;
  settings: PreviewSettings;
  selectedId: string;
  onSelect: (scene: Scene) => void;
  entryContentHash: string | null;
  onProjectChanged: ProjectChanged;
}) {
  const studio = useStudioSession();
  const { interaction, interactionRef, applyInteraction } = useEditorInteraction();
  const [showLayers, setShowLayers] = React.useState(false);
  const draggedId = React.useRef<string | null>(null);
  const dropRef = React.useRef<{ sceneId: string; placement: "before" | "after" } | null>(null);
  const [drop, setDrop] = React.useState<{ sceneId: string; placement: "before" | "after" } | null>(null);
  const [issue, setIssue] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const entryHashRef = React.useRef(entryContentHash);
  const liveScenes = useLiveScenes(scenes);
  const requestInit = React.useMemo(() => studio.request(), [studio]);

  React.useEffect(() => {
    if (entryContentHash !== null) entryHashRef.current = entryContentHash;
  }, [entryContentHash]);

  // Shared with the timeline so a card and a lane carry the same number.
  const { content: contentScenes, layers } = splitScenes(scenes);
  const clips = React.useMemo(() => scenes.map((scene) => ({
    sceneId: scene.id,
    start: scene.start,
    duration: scene.duration,
    trackIndex: scene.trackIndex,
  })), [scenes]);

  const select = React.useCallback((scene: Scene, modifiers: { shift?: boolean; additive?: boolean }) => {
    applyInteraction(selectClip(interactionRef.current, clips, scene.id, modifiers));
    onSelect(scene);
  }, [applyInteraction, clips, interactionRef, onSelect]);

  const saveIntent = React.useCallback(async (intent: ReturnType<typeof reorderDropIntent>) => {
    const expectedContentHash = entryHashRef.current;
    if (intent.kind !== "ready" || !expectedContentHash || pending) return;
    setPending(true);
    setIssue(null);
    try {
      const result = await saveSceneReorder({
        projectId,
        expectedContentHash,
        sceneId: intent.sceneId,
        toIndex: intent.toIndex,
        ...(intent.toTrackIndex === undefined ? {} : { toTrackIndex: intent.toTrackIndex }),
        send: ({ path, method, body }) => fetchApi(path, studio.request({
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })),
      });
      if (result.kind === "saved") {
        entryHashRef.current = result.file.contentHash;
        setAnnouncement(`Moved ${intent.sceneId} to position ${intent.toIndex + 1}.`);
        onProjectChanged(mutationChangeSeq(result));
      } else setIssue(result.message);
    } catch (cause) {
      setIssue(cause instanceof Error ? cause.message : "Scene reorder failed.");
    } finally {
      setPending(false);
    }
  }, [onProjectChanged, pending, projectId, studio]);

  const reorderByKeyboard = React.useCallback((scene: Scene, direction: -1 | 1) => {
    const intent = keyboardReorderIntent(scenes, scene.id, direction);
    if (intent.kind === "ready") void saveIntent(intent);
    else if (intent.kind === "boundary") setAnnouncement(`${scene.id} is already at the boundary.`);
    else setIssue(intent.message);
  }, [saveIntent, scenes]);

  const card = ({ scene, index }: OrderedScene) => (
    <SceneCard
      key={scene.id}
      scene={scene}
      index={index}
      projectId={projectId}
      projectRevision={projectRevision}
      frameRate={frameRate}
      requestInit={requestInit}
      selected={interaction.selection.size > 0 ? interaction.selection.has(scene.id) : scene.id === selectedId}
      live={liveScenes.has(scene.id)}
      hidden={sceneSettings(settings, scene.id).hidden}
      onSelect={select}
      dropPlacement={drop?.sceneId === scene.id ? drop.placement : null}
      onDragStart={(dragged) => {
        draggedId.current = dragged.id;
        setIssue(null);
      }}
      onDragOver={(target, placement) => {
        dropRef.current = { sceneId: target.id, placement };
        setDrop(dropRef.current);
      }}
      onDrop={(target, placement) => {
        if (draggedId.current) {
          const intent = reorderDropIntent(scenes, draggedId.current, target.id, placement);
          if (intent.kind === "ready") void saveIntent(intent);
          else if (intent.kind === "rejected") setIssue(intent.message);
        }
        draggedId.current = null;
        dropRef.current = null;
        setDrop(null);
      }}
      onDragEnd={() => {
        const fallback = dropRef.current;
        if (draggedId.current && fallback) {
          const intent = reorderDropIntent(scenes, draggedId.current, fallback.sceneId, fallback.placement);
          if (intent.kind === "ready") void saveIntent(intent);
          else if (intent.kind === "rejected") setIssue(intent.message);
        }
        draggedId.current = null;
        dropRef.current = null;
        setDrop(null);
      }}
      onReorderKeyDown={reorderByKeyboard}
    />
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        <span className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
          Storyboard · {contentScenes.length}
        </span>
      </header>

      <span className="sr-only" aria-live="polite">{announcement}</span>
      {issue ? <p className="text-destructive text-[10px]" role="alert">{issue}</p> : null}

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
