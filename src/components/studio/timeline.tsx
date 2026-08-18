"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api/services";
import {
  beginDrag,
  cancelDrag,
  clearSelection,
  commitDrag,
  finishMarquee,
  moveDrag,
  selectClip,
  startMarquee,
  timelineSnapCandidates,
  updateMarquee,
  type ClipBounds,
  type DragZone,
  type EditorCommit,
} from "@/lib/studio/editor-interaction";
import { keyboardReorderIntent, orderedScenes, reorderDropIntent } from "@/lib/studio/scene-order";
import {
  sceneSettings,
  type PreviewSettings,
} from "@/lib/studio/preview-settings";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import { mutationChangeSeq } from "@/lib/studio/preview-reload";
import { saveSceneTiming } from "@/lib/studio/scene-timing-mutation";
import {
  deleteSceneSelection,
  prepareSceneSelectionDeletion,
  saveSceneGroupMove,
  saveSceneReorder,
  type PreparedSceneDeletion,
} from "@/lib/studio/scene-order-mutation";
import type { RootTrack, Scene } from "@/lib/studio/types";
import { cn } from "@/lib/utils";
import { Playhead, useLiveScenes, useTimeStore } from "./player-time";
import { TIMELINE_GUTTER_PX, ZOOM_LEVELS } from "./timeline-constants";
import { TimelineElementRows, TimelineRootRows } from "./timeline-elements";
import { TimelineRuler } from "./timeline-ruler";
import { TimelineToolbar } from "./timeline-toolbar";
import { TimelineLane, TimelineRootLane } from "./timeline-track";
import { useMutationHistory } from "./use-mutation-history";
import { useStudioSession } from "./studio-session-context";
import { useEditorInteraction } from "./editor-interaction-context";

/**
 * The composition on a time axis, built from the same `Scene[]` the storyboard
 * renders. Both panes therefore agree on what a scene is, what number it has
 * and which one is selected — before this, the timeline listed source files in
 * track order while the storyboard listed beats in playback order, and nothing
 * tied a row to a card.
 */
export function Timeline({
  projectId,
  scenes,
  rootTrack,
  settings,
  duration,
  frameRate,
  entryContentHash,
  projectRevision,
  selectedId,
  onScrub,
  onSelect,
  onToggleHidden,
  onProjectChanged,
}: {
  projectId: string;
  scenes: Scene[];
  /** The entry document's own media and motion, when it has any. */
  rootTrack: RootTrack | null;
  settings: PreviewSettings;
  duration: number;
  frameRate: number;
  entryContentHash: string | null;
  projectRevision: number;
  selectedId: string;
  onScrub: (seconds: number) => void;
  onSelect: (scene: Scene) => void;
  onToggleHidden: (scene: Scene) => void;
  onProjectChanged: ProjectChanged;
}) {
  const history = useMutationHistory(projectId, onProjectChanged);
  const studio = useStudioSession();
  const { interaction, interactionRef, applyInteraction } = useEditorInteraction();
  const timeStore = useTimeStore();
  const [zoom, setZoom] = React.useState(1);
  const [laneWidth, setLaneWidth] = React.useState(0);
  const viewport = React.useRef<HTMLDivElement>(null);
  const marqueeSurface = React.useRef<HTMLDivElement>(null);

  // Collapsed by default so the timeline still reads as a list of beats, with
  // the selected scene open. Derived rather than synced from an effect: only
  // the scenes the user explicitly toggled are stored, so selecting a scene
  // opens it without a render pass that first shows it closed.
  const [override, setOverride] = React.useState<Record<string, boolean>>({});
  // The root track has no scene id; it opens by default because its footage is
  // usually the thing being timed against.
  const isExpanded = (sceneId: string) =>
    override[sceneId] ?? (sceneId === ROOT_LANE || sceneId === selectedId);
  // The lane already knows whether it is open, and passing that back keeps this
  // handler stable — a new identity per render would defeat the memoized lanes.
  const toggleExpanded = React.useCallback(
    (sceneId: string, expanded: boolean) =>
      setOverride((current) => ({ ...current, [sceneId]: !expanded })),
    [],
  );

  // The lane area is whatever is left of the viewport once the pinned gutter is
  // taken out, so "Fit" has to be measured rather than assumed.
  React.useEffect(() => {
    const element = viewport.current;
    if (!element) return;

    const measure = () => setLaneWidth(element.clientWidth - TIMELINE_GUTTER_PX);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const ordered = React.useMemo(() => orderedScenes(scenes), [scenes]);
  const clips = React.useMemo(() => scenes.map((scene) => ({
    sceneId: scene.id,
    start: scene.start,
    duration: scene.duration,
    trackIndex: scene.trackIndex,
  })), [scenes]);
  const liveScenes = useLiveScenes(scenes);
  const fitScale = duration > 0 && laneWidth > 0 ? laneWidth / duration : 0;
  const pixelsPerSecond = fitScale * zoom;
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);

  const selected = ordered.find(({ scene }) => scene.id === selectedId);
  const [rippleEnabled, setRippleEnabled] = React.useState(false);
  const [pendingTiming, setPendingTiming] = React.useState(false);
  const [timingIssue, setTimingIssue] = React.useState<{
    kind: "source-conflict" | "root-overflow" | "runtime-overflow" | "failed";
    message: string;
    commit?: EditorCommit;
    reorder?: Extract<ReturnType<typeof reorderDropIntent>, { kind: "ready" }>;
  } | null>(null);
  const entryHashRef = React.useRef(entryContentHash);
  const [reorderDragId, setReorderDragId] = React.useState<string | null>(null);
  const [reorderDrop, setReorderDrop] = React.useState<{
    sceneId: string;
    placement: "before" | "after";
  } | null>(null);
  const [preparedDeletion, setPreparedDeletion] = React.useState<PreparedSceneDeletion | null>(null);
  const [deletionPending, setDeletionPending] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");

  React.useEffect(() => {
    if (entryContentHash !== null) entryHashRef.current = entryContentHash;
  }, [entryContentHash]);

  const saveCommit = React.useCallback(async (commit: EditorCommit, extendRoot = false) => {
    const expectedContentHash = entryHashRef.current;
    if (!expectedContentHash || pendingTiming) return;
    setPendingTiming(true);
    setTimingIssue(null);
    try {
      const result = "sceneIds" in commit
        ? await saveSceneGroupMove({
            projectId,
            expectedContentHash,
            sceneIds: commit.sceneIds,
            deltaSeconds: commit.deltaSeconds,
            extendRoot,
            send: ({ path, method, body }) => fetchApi(path, studio.request({
              method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })),
          })
        : await saveSceneTiming({
          projectId,
          expectedContentHash,
          commit,
          extendRoot,
          send: ({ path, body }) => fetchApi(path, studio.request({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })),
      });
      if (result.kind === "saved") {
        entryHashRef.current = result.file.contentHash;
        onProjectChanged(mutationChangeSeq(result));
      } else if (result.kind !== "no-change") {
        setTimingIssue({
          kind: result.kind,
          message: result.kind === "source-conflict"
            ? "Source changed outside this studio. Reload source before trying again."
            : result.message,
          ...(result.kind === "root-overflow" ? { commit } : {}),
        });
      }
    } catch (cause) {
      setTimingIssue({
        kind: "failed",
        message: cause instanceof Error ? cause.message : "Timing save failed.",
      });
    } finally {
      setPendingTiming(false);
    }
  }, [onProjectChanged, pendingTiming, projectId, studio]);

  const selectScene = React.useCallback((scene: Scene, modifiers: { shift?: boolean; additive?: boolean }) => {
    applyInteraction(selectClip(interactionRef.current, clips, scene.id, modifiers));
    onSelect(scene);
  }, [applyInteraction, clips, interactionRef, onSelect]);

  const candidatesFor = React.useCallback((scene: Scene) => {
    const selection = interactionRef.current.selection;
    const excludedSceneIds = selection.size > 1 && selection.has(scene.id) ? selection : undefined;
    return timelineSnapCandidates({
    clip: { sceneId: scene.id, start: scene.start, duration: scene.duration, trackIndex: scene.trackIndex },
    clips,
    playhead: timeStore.get(),
    duration,
    excludedSceneIds,
  });
  }, [clips, duration, interactionRef, timeStore]);

  const startDrag = React.useCallback((scene: Scene, zone: DragZone, pointerX: number) => {
    if (pendingTiming || pixelsPerSecond <= 0) return;
    const base = { ...interactionRef.current, pixelsPerSecond };
    applyInteraction(beginDrag(base, {
      clip: { sceneId: scene.id, start: scene.start, duration: scene.duration, trackIndex: scene.trackIndex },
      clips,
      zone,
      pointerX,
      ripple: rippleEnabled,
      selectedSceneIds: interactionRef.current.selection,
    }));
  }, [applyInteraction, clips, interactionRef, pendingTiming, pixelsPerSecond, rippleEnabled]);

  const continueDrag = React.useCallback((scene: Scene, pointerX: number) => {
    const current = interactionRef.current;
    if (current.drag?.clip.sceneId !== scene.id) return;
    applyInteraction(moveDrag(current, {
      pointerX,
      fps: frameRate,
      candidates: candidatesFor(scene),
    }));
  }, [applyInteraction, candidatesFor, frameRate, interactionRef]);

  const endDrag = React.useCallback((scene: Scene, pointerX: number) => {
    const current = interactionRef.current;
    if (current.drag?.clip.sceneId !== scene.id) return;
    const moved = moveDrag(current, {
      pointerX,
      fps: frameRate,
      candidates: candidatesFor(scene),
    });
    const commit = commitDrag(moved);
    applyInteraction(cancelDrag(moved));
    if (commit) void saveCommit(commit);
  }, [applyInteraction, candidatesFor, frameRate, interactionRef, saveCommit]);

  const cancelCurrentDrag = React.useCallback(() => {
    applyInteraction(cancelDrag(interactionRef.current));
  }, [applyInteraction, interactionRef]);

  const sendSceneOrder = React.useCallback(
    ({ path, method, body }: { path: `/api/${string}`; method: "PATCH" | "POST"; body: Record<string, unknown> }) =>
      fetchApi(path, studio.request({
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })),
    [studio],
  );

  const saveReorder = React.useCallback(async (
    intent: ReturnType<typeof reorderDropIntent>,
    extendRoot = false,
  ) => {
    const expectedContentHash = entryHashRef.current;
    if (intent.kind !== "ready" || !expectedContentHash || pendingTiming) return;
    setPendingTiming(true);
    setTimingIssue(null);
    try {
      const result = await saveSceneReorder({
        projectId,
        expectedContentHash,
        sceneId: intent.sceneId,
        toIndex: intent.toIndex,
        ...(intent.toTrackIndex === undefined ? {} : { toTrackIndex: intent.toTrackIndex }),
        extendRoot,
        send: sendSceneOrder,
      });
      if (result.kind === "saved") {
        entryHashRef.current = result.file.contentHash;
        setAnnouncement(`Moved ${intent.sceneId} to position ${intent.toIndex + 1}.`);
        onProjectChanged(mutationChangeSeq(result));
      } else if (result.kind === "root-overflow") {
        setTimingIssue({ kind: "root-overflow", message: result.message, reorder: intent });
      } else {
        setTimingIssue({ kind: result.kind === "source-conflict" ? "source-conflict" : result.kind === "runtime-overflow" ? "runtime-overflow" : "failed", message: result.message });
      }
    } catch (cause) {
      setTimingIssue({ kind: "failed", message: cause instanceof Error ? cause.message : "Scene reorder failed." });
    } finally {
      setPendingTiming(false);
    }
  }, [onProjectChanged, pendingTiming, projectId, sendSceneOrder]);

  const dropReorder = React.useCallback((target: Scene, placement: "before" | "after") => {
    if (reorderDragId) {
      const intent = reorderDropIntent(scenes, reorderDragId, target.id, placement, { allowCrossTrack: true });
      if (intent.kind === "ready") void saveReorder(intent);
      else if (intent.kind === "rejected") setTimingIssue({ kind: "failed", message: intent.message });
    }
    setReorderDragId(null);
    setReorderDrop(null);
  }, [reorderDragId, saveReorder, scenes]);

  const keyboardReorder = React.useCallback((scene: Scene, direction: -1 | 1) => {
    const intent = keyboardReorderIntent(scenes, scene.id, direction);
    if (intent.kind === "ready") void saveReorder(intent);
    else if (intent.kind === "boundary") setAnnouncement(`${scene.id} is already at the boundary.`);
    else if (intent.kind === "rejected") setTimingIssue({ kind: "failed", message: intent.message });
  }, [saveReorder, scenes]);

  const beginDeletion = React.useCallback(async () => {
    const sceneIds = [...interactionRef.current.selection];
    if (sceneIds.length === 0 || deletionPending) return;
    setDeletionPending(true);
    setTimingIssue(null);
    try {
      setPreparedDeletion(await prepareSceneSelectionDeletion({
        projectId,
        sceneIds,
        expectedRevision: projectRevision,
        send: sendSceneOrder,
      }));
    } catch (cause) {
      setPreparedDeletion({ kind: "failed", message: cause instanceof Error ? cause.message : "Deletion planning failed." });
    } finally {
      setDeletionPending(false);
    }
  }, [deletionPending, interactionRef, projectId, projectRevision, sendSceneOrder]);

  const confirmDeletion = React.useCallback(async () => {
    if (preparedDeletion?.kind !== "prepared" || deletionPending) return;
    setDeletionPending(true);
    try {
      const result = await deleteSceneSelection({
        projectId,
        sceneIds: preparedDeletion.sceneIds,
        expectedRevision: projectRevision,
        grantId: preparedDeletion.grantId,
        send: sendSceneOrder,
      });
      if (result.kind === "deleted") {
        setPreparedDeletion(null);
        applyInteraction(clearSelection(interactionRef.current));
        onProjectChanged(result.changeSeq);
      } else setPreparedDeletion({ kind: "failed", message: result.message });
    } catch (cause) {
      setPreparedDeletion({ kind: "failed", message: cause instanceof Error ? cause.message : "Scene deletion failed." });
    } finally {
      setDeletionPending(false);
    }
  }, [applyInteraction, deletionPending, interactionRef, onProjectChanged, preparedDeletion, projectId, projectRevision, sendSceneOrder]);

  const marqueePoint = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }, []);

  const beginMarquee = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.clientX - event.currentTarget.getBoundingClientRect().left < TIMELINE_GUTTER_PX
      || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyInteraction(startMarquee(interactionRef.current, marqueePoint(event)));
  }, [applyInteraction, interactionRef, marqueePoint]);

  const moveMarquee = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !interactionRef.current.marquee) return;
    applyInteraction(updateMarquee(interactionRef.current, marqueePoint(event)));
  }, [applyInteraction, interactionRef, marqueePoint]);

  const endMarquee = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !interactionRef.current.marquee) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const surface = event.currentTarget.getBoundingClientRect();
    const bounds: ClipBounds[] = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-timeline-scene-id]")]
      .map((clip) => {
        const rect = clip.getBoundingClientRect();
        return {
          sceneId: clip.dataset.timelineSceneId!,
          left: rect.left - surface.left,
          top: rect.top - surface.top,
          right: rect.right - surface.left,
          bottom: rect.bottom - surface.top,
        };
      });
    applyInteraction(finishMarquee(interactionRef.current, bounds));
  }, [applyInteraction, interactionRef]);

  React.useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        applyInteraction(clearSelection(cancelDrag(interactionRef.current)));
        setPreparedDeletion(null);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [applyInteraction, interactionRef]);

  return (
    <div className="bg-sidebar flex h-full flex-col">
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <TimelineToolbar
        history={history}
        zoom={zoom}
        canZoomIn={zoomIndex < ZOOM_LEVELS.length - 1}
        canZoomOut={zoomIndex > 0}
        sceneCount={ordered.length}
        selectedLabel={selected ? `${selected.index}. ${selected.scene.id}` : null}
        selectedCount={interaction.selection.size}
        snapEnabled={interaction.snapEnabled}
        rippleEnabled={rippleEnabled}
        pendingTiming={pendingTiming || deletionPending}
        onDeleteSelection={() => void beginDeletion()}
        onToggleSnap={() => applyInteraction({
          ...interactionRef.current,
          snapEnabled: !interactionRef.current.snapEnabled,
        })}
        onToggleRipple={() => setRippleEnabled((current) => !current)}
        onFit={() => setZoom(1)}
        onZoomIn={() =>
          setZoom(ZOOM_LEVELS[Math.min(zoomIndex + 1, ZOOM_LEVELS.length - 1)])
        }
        onZoomOut={() => setZoom(ZOOM_LEVELS[Math.max(zoomIndex - 1, 0)])}
      />

      {timingIssue ? (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-2 py-1" role="alert">
          <span className="min-w-0 flex-1 text-[10px] text-amber-700 dark:text-amber-300">
            {timingIssue.message}
          </span>
          {timingIssue.kind === "source-conflict" ? (
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => {
              setTimingIssue(null);
              onProjectChanged(null);
            }}>
              Reload source
            </Button>
          ) : null}
          {timingIssue.kind === "root-overflow" && (timingIssue.commit || timingIssue.reorder) ? (
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => {
              if (timingIssue.commit) void saveCommit(timingIssue.commit, true);
              else if (timingIssue.reorder) void saveReorder(timingIssue.reorder, true);
            }}>
              Extend root
            </Button>
          ) : null}
        </div>
      ) : null}

      {preparedDeletion ? (
        <div className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-2 py-1" role="alert">
          {preparedDeletion.kind === "prepared" ? (
            <>
              <span className="min-w-0 flex-1 text-[10px] text-red-700 dark:text-red-300">
                Delete {preparedDeletion.sceneIds.length} selected scene{preparedDeletion.sceneIds.length === 1 ? "" : "s"} in one revision: {preparedDeletion.sceneIds.join(", ")}
              </span>
              <Button variant="destructive" size="sm" className="h-6 text-[10px]" disabled={deletionPending} onClick={() => void confirmDeletion()}>
                Confirm delete
              </Button>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" disabled={deletionPending} onClick={() => setPreparedDeletion(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 text-[10px] text-red-700 dark:text-red-300">{preparedDeletion.message}</span>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setPreparedDeletion(null)}>Dismiss</Button>
            </>
          )}
        </div>
      ) : null}

      <div ref={viewport} className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ width: TIMELINE_GUTTER_PX + duration * pixelsPerSecond }}>
          <TimelineRuler
            duration={duration}
            pixelsPerSecond={pixelsPerSecond}
            onScrub={onScrub}
          />

          <div
            ref={marqueeSurface}
            className="relative"
            onPointerDown={beginMarquee}
            onPointerMove={moveMarquee}
            onPointerUp={endMarquee}
            onPointerCancel={endMarquee}
          >
            {rootTrack ? (
              <>
                <TimelineRootLane
                  track={rootTrack}
                  pixelsPerSecond={pixelsPerSecond}
                  expanded={isExpanded(ROOT_LANE)}
                  laneId={ROOT_LANE}
                  onToggleExpanded={toggleExpanded}
                />
                {isExpanded(ROOT_LANE) ? (
                  <TimelineRootRows
                    track={rootTrack}
                    pixelsPerSecond={pixelsPerSecond}
                  />
                ) : null}
              </>
            ) : null}

            {ordered.map(({ scene, index }) => {
              const groupPreview = interaction.drag?.groupPreview.find((clip) => clip.sceneId === scene.id);
              const dragPreview = interaction.drag?.clip.sceneId === scene.id
                ? interaction.drag.preview
                : groupPreview;
              const displayScene = dragPreview ? { ...scene, ...dragPreview } : scene;
              const isSelected = interaction.selection.size > 0
                ? interaction.selection.has(scene.id)
                : scene.id === selectedId;
              return (
              <React.Fragment key={scene.id}>
                <TimelineLane
                  scene={displayScene}
                  index={index}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={isSelected}
                  live={liveScenes.has(scene.id)}
                  hidden={sceneSettings(settings, scene.id).hidden}
                  expanded={isExpanded(scene.id)}
                  onSelect={selectScene}
                  onToggleHidden={onToggleHidden}
                  onToggleExpanded={toggleExpanded}
                  onDragStart={startDrag}
                  onDragMove={continueDrag}
                  onDragEnd={endDrag}
                  onDragCancel={cancelCurrentDrag}
                  reorderPlacement={reorderDrop?.sceneId === scene.id ? reorderDrop.placement : null}
                  onReorderDragStart={(dragged) => {
                    setReorderDragId(dragged.id);
                    setTimingIssue(null);
                  }}
                  onReorderDragOver={(target, placement) => setReorderDrop({ sceneId: target.id, placement })}
                  onReorderDrop={dropReorder}
                  onReorderDragEnd={() => {
                    setReorderDragId(null);
                    setReorderDrop(null);
                  }}
                  onReorderKeyDown={keyboardReorder}
                />
                {isExpanded(scene.id) ? (
                  <TimelineElementRows
                    scene={scene}
                    pixelsPerSecond={pixelsPerSecond}
                  />
                ) : null}
              </React.Fragment>
              );
            })}

            {interaction.marquee ? (
              <span
                className="border-studio-accent bg-studio-accent/15 pointer-events-none absolute z-30 border"
                style={{
                  left: Math.min(interaction.marquee.fromX, interaction.marquee.toX),
                  top: Math.min(interaction.marquee.fromY, interaction.marquee.toY),
                  width: Math.abs(interaction.marquee.toX - interaction.marquee.fromX),
                  height: Math.abs(interaction.marquee.toY - interaction.marquee.fromY),
                }}
              />
            ) : null}

            {interaction.drag?.snappedTo ? (
              <span
                className="bg-studio-accent pointer-events-none absolute inset-y-0 z-20 w-px"
                style={{ left: TIMELINE_GUTTER_PX + interaction.drag.snappedTo.time * pixelsPerSecond }}
                data-snap-marker={interaction.drag.snappedTo.id}
              />
            ) : null}
            {interaction.drag?.rippleSceneCount ? (
              <span className="bg-studio-accent text-studio-accent-foreground pointer-events-none absolute top-1 right-2 z-20 rounded px-1.5 py-0.5 text-[10px]">
                {interaction.drag.rippleSceneCount} scene{interaction.drag.rippleSceneCount === 1 ? "" : "s"} ripple
              </span>
            ) : null}

            {/* One playhead over every lane, not one per row: a line drawn per
                lane visibly stair-steps as rows scroll. */}
            <Playhead
              pixelsPerSecond={pixelsPerSecond}
              offset={TIMELINE_GUTTER_PX}
              className={cn(
                "bg-studio-accent pointer-events-none absolute inset-y-0 z-10 w-px",
                ordered.length === 0 && "hidden",
              )}
            />
          </div>
        </div>

        {ordered.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">
            No scenes found in this composition.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Expansion key for the root track, which has no scene id of its own. */
const ROOT_LANE = "\u0000root-track";
