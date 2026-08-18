"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api/services";
import {
  beginDrag,
  cancelDrag,
  commitDrag,
  createEditorInteractionState,
  moveDrag,
  timelineSnapCandidates,
  type DragZone,
  type EditorInteractionState,
  type TimingCommit,
} from "@/lib/studio/editor-interaction";
import { orderedScenes } from "@/lib/studio/scene-order";
import {
  sceneSettings,
  type PreviewSettings,
} from "@/lib/studio/preview-settings";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import { mutationChangeSeq } from "@/lib/studio/preview-reload";
import { saveSceneTiming } from "@/lib/studio/scene-timing-mutation";
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
  selectedId: string;
  onScrub: (seconds: number) => void;
  onSelect: (scene: Scene) => void;
  onToggleHidden: (scene: Scene) => void;
  onProjectChanged: ProjectChanged;
}) {
  const history = useMutationHistory(projectId, onProjectChanged);
  const studio = useStudioSession();
  const timeStore = useTimeStore();
  const [zoom, setZoom] = React.useState(1);
  const [laneWidth, setLaneWidth] = React.useState(0);
  const viewport = React.useRef<HTMLDivElement>(null);

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
  const liveScenes = useLiveScenes(scenes);
  const fitScale = duration > 0 && laneWidth > 0 ? laneWidth / duration : 0;
  const pixelsPerSecond = fitScale * zoom;
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);

  const selected = ordered.find(({ scene }) => scene.id === selectedId);
  const [interaction, setInteraction] = React.useState(() =>
    createEditorInteractionState({ pixelsPerSecond: 1, snapEnabled: true }));
  const interactionRef = React.useRef(interaction);
  const [rippleEnabled, setRippleEnabled] = React.useState(false);
  const [pendingTiming, setPendingTiming] = React.useState(false);
  const [timingIssue, setTimingIssue] = React.useState<{
    kind: "source-conflict" | "root-overflow" | "runtime-overflow" | "failed";
    message: string;
    commit?: TimingCommit;
  } | null>(null);
  const entryHashRef = React.useRef(entryContentHash);

  React.useEffect(() => {
    if (entryContentHash !== null) entryHashRef.current = entryContentHash;
  }, [entryContentHash]);

  const applyInteraction = React.useCallback((next: EditorInteractionState) => {
    interactionRef.current = next;
    setInteraction(next);
  }, []);

  const saveCommit = React.useCallback(async (commit: TimingCommit, extendRoot = false) => {
    const expectedContentHash = entryHashRef.current;
    if (!expectedContentHash || pendingTiming) return;
    setPendingTiming(true);
    setTimingIssue(null);
    try {
      const result = await saveSceneTiming({
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

  const candidatesFor = React.useCallback((scene: Scene) => timelineSnapCandidates({
    clip: { sceneId: scene.id, start: scene.start, duration: scene.duration, trackIndex: scene.trackIndex },
    clips: scenes.map((clip) => ({
      sceneId: clip.id, start: clip.start, duration: clip.duration, trackIndex: clip.trackIndex,
    })),
    playhead: timeStore.get(),
    duration,
  }), [duration, scenes, timeStore]);

  const startDrag = React.useCallback((scene: Scene, zone: DragZone, pointerX: number) => {
    if (pendingTiming || pixelsPerSecond <= 0) return;
    const base = { ...interactionRef.current, pixelsPerSecond };
    applyInteraction(beginDrag(base, {
      clip: { sceneId: scene.id, start: scene.start, duration: scene.duration, trackIndex: scene.trackIndex },
      clips: scenes.map((clip) => ({
        sceneId: clip.id, start: clip.start, duration: clip.duration, trackIndex: clip.trackIndex,
      })),
      zone,
      pointerX,
      ripple: rippleEnabled,
    }));
  }, [applyInteraction, pendingTiming, pixelsPerSecond, rippleEnabled, scenes]);

  const continueDrag = React.useCallback((scene: Scene, pointerX: number) => {
    const current = interactionRef.current;
    if (current.drag?.clip.sceneId !== scene.id) return;
    applyInteraction(moveDrag(current, {
      pointerX,
      fps: frameRate,
      candidates: candidatesFor(scene),
    }));
  }, [applyInteraction, candidatesFor, frameRate]);

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
  }, [applyInteraction, candidatesFor, frameRate, saveCommit]);

  const cancelCurrentDrag = React.useCallback(() => {
    applyInteraction(cancelDrag(interactionRef.current));
  }, [applyInteraction]);

  React.useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && interactionRef.current.drag) cancelCurrentDrag();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancelCurrentDrag]);

  return (
    <div className="bg-sidebar flex h-full flex-col">
      <TimelineToolbar
        history={history}
        zoom={zoom}
        canZoomIn={zoomIndex < ZOOM_LEVELS.length - 1}
        canZoomOut={zoomIndex > 0}
        sceneCount={ordered.length}
        selectedLabel={selected ? `${selected.index}. ${selected.scene.id}` : null}
        snapEnabled={interaction.snapEnabled}
        rippleEnabled={rippleEnabled}
        pendingTiming={pendingTiming}
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
          {timingIssue.kind === "root-overflow" && timingIssue.commit ? (
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() =>
              void saveCommit(timingIssue.commit!, true)}>
              Extend root
            </Button>
          ) : null}
        </div>
      ) : null}

      <div ref={viewport} className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ width: TIMELINE_GUTTER_PX + duration * pixelsPerSecond }}>
          <TimelineRuler
            duration={duration}
            pixelsPerSecond={pixelsPerSecond}
            onScrub={onScrub}
          />

          <div className="relative">
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

            {ordered.map(({ scene, index }) => (
              <React.Fragment key={scene.id}>
                <TimelineLane
                  scene={interaction.drag?.clip.sceneId === scene.id
                    ? { ...scene, ...interaction.drag.preview }
                    : scene}
                  index={index}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={scene.id === selectedId}
                  live={liveScenes.has(scene.id)}
                  hidden={sceneSettings(settings, scene.id).hidden}
                  expanded={isExpanded(scene.id)}
                  onSelect={onSelect}
                  onToggleHidden={onToggleHidden}
                  onToggleExpanded={toggleExpanded}
                  onDragStart={startDrag}
                  onDragMove={continueDrag}
                  onDragEnd={endDrag}
                  onDragCancel={cancelCurrentDrag}
                />
                {isExpanded(scene.id) ? (
                  <TimelineElementRows
                    scene={scene}
                    pixelsPerSecond={pixelsPerSecond}
                  />
                ) : null}
              </React.Fragment>
            ))}

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
