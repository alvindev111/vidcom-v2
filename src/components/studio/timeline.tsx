"use client";

import * as React from "react";

import { orderedScenes } from "@/lib/studio/scene-order";
import {
  sceneSettings,
  type PreviewSettings,
} from "@/lib/studio/preview-settings";
import type { RootTrack, Scene } from "@/lib/studio/types";
import { cn } from "@/lib/utils";
import { Playhead, useLiveScenes } from "./player-time";
import { TIMELINE_GUTTER_PX, ZOOM_LEVELS } from "./timeline-constants";
import { TimelineElementRows, TimelineRootRows } from "./timeline-elements";
import { TimelineRuler } from "./timeline-ruler";
import { TimelineToolbar } from "./timeline-toolbar";
import { TimelineLane, TimelineRootLane } from "./timeline-track";
import { useMutationHistory } from "./use-mutation-history";

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
  selectedId: string;
  onScrub: (seconds: number) => void;
  onSelect: (scene: Scene) => void;
  onToggleHidden: (scene: Scene) => void;
  onProjectChanged: () => void;
}) {
  const history = useMutationHistory(projectId, onProjectChanged);
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

  return (
    <div className="bg-sidebar flex h-full flex-col">
      <TimelineToolbar
        history={history}
        zoom={zoom}
        canZoomIn={zoomIndex < ZOOM_LEVELS.length - 1}
        canZoomOut={zoomIndex > 0}
        sceneCount={ordered.length}
        selectedLabel={selected ? `${selected.index}. ${selected.scene.id}` : null}
        onFit={() => setZoom(1)}
        onZoomIn={() =>
          setZoom(ZOOM_LEVELS[Math.min(zoomIndex + 1, ZOOM_LEVELS.length - 1)])
        }
        onZoomOut={() => setZoom(ZOOM_LEVELS[Math.max(zoomIndex - 1, 0)])}
      />

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
                  scene={scene}
                  index={index}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={scene.id === selectedId}
                  live={liveScenes.has(scene.id)}
                  hidden={sceneSettings(settings, scene.id).hidden}
                  expanded={isExpanded(scene.id)}
                  onSelect={onSelect}
                  onToggleHidden={onToggleHidden}
                  onToggleExpanded={toggleExpanded}
                />
                {isExpanded(scene.id) ? (
                  <TimelineElementRows
                    scene={scene}
                    pixelsPerSecond={pixelsPerSecond}
                  />
                ) : null}
              </React.Fragment>
            ))}

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
