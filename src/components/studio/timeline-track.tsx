"use client";

import * as React from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FilmIcon,
} from "lucide-react";

import { formatTimecode } from "@/lib/studio/format";
import type { DragZone } from "@/lib/studio/editor-interaction";
import { hitZone } from "@/lib/studio/snap";
import { groupOf } from "@/lib/studio/snapshots";
import type { RootTrack, Scene } from "@/lib/studio/types";
import { cn } from "@/lib/utils";
import { TIMELINE_GUTTER_STYLE } from "./timeline-constants";

const GROUP_STYLE: Record<string, string> = {
  scene: "bg-studio-accent/25 border-studio-accent/50",
  transition: "bg-amber-500/25 border-amber-500/50",
  overlay: "bg-violet-500/25 border-violet-500/50",
};

/**
 * Lane for the entry document's own track.
 *
 * Deliberately not a scene lane: it has no composition host, so it carries no
 * number, cannot be selected as a beat and cannot be hidden. It exists so a
 * footage-led composition shows its footage — before this the A-roll and the
 * camera moves authored around it were absent from the timeline entirely.
 */
export const TimelineRootLane = React.memo(function TimelineRootLane({
  track,
  pixelsPerSecond,
  expanded,
  laneId,
  onToggleExpanded,
}: {
  track: RootTrack;
  pixelsPerSecond: number;
  expanded: boolean;
  /** Expansion key — the root track has no scene id of its own. */
  laneId: string;
  onToggleExpanded: (laneId: string, expanded: boolean) => void;
}) {
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  const inside = track.elements.length + track.unresolvedEffects;

  return (
    <div className="bg-muted/20 flex h-10 shrink-0 border-b">
      <div
        style={TIMELINE_GUTTER_STYLE}
        className="bg-sidebar sticky left-0 z-20 flex shrink-0 items-center gap-1.5 border-r px-1.5"
      >
        <button
          type="button"
          onClick={() => onToggleExpanded(laneId, expanded)}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${track.id}`}
          aria-expanded={expanded}
          title={`${inside} root-level clip${inside === 1 ? "" : "s"} and effects`}
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm"
        >
          <Chevron className="size-3.5" />
        </button>
        <FilmIcon className="text-muted-foreground size-3 shrink-0" />
        <span
          title={`${track.id} · index.html`}
          className="min-w-0 grow truncate text-[11px] font-medium"
        >
          {track.id}
        </span>
      </div>

      <div className="relative grow">
        <span
          title={`root composition · ${formatTimecode(0)} → ${formatTimecode(track.duration)}`}
          className="absolute inset-y-1.5 flex items-center overflow-hidden rounded-sm border border-dashed border-neutral-500/50 bg-neutral-500/15 px-1.5"
          style={{ left: 0, width: Math.max(track.duration * pixelsPerSecond, 6) }}
        >
          <span className="text-foreground/70 truncate font-mono text-[10px]">
            index.html
          </span>
        </span>
      </div>
    </div>
  );
});

/**
 * One lane per scene, addressed the same way the storyboard addresses it — same
 * number, same name, same grouping colour — so a card above and a bar down here
 * are visibly the same thing.
 *
 * Memoized, and every callback takes the scene rather than closing over it, so
 * the playhead crossing a boundary repaints the two lanes that changed instead
 * of all of them.
 */
export const TimelineLane = React.memo(function TimelineLane({
  scene,
  index,
  pixelsPerSecond,
  selected,
  live,
  hidden,
  expanded,
  onSelect,
  onToggleHidden,
  onToggleExpanded,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
  reorderPlacement,
  onReorderDragStart,
  onReorderDragOver,
  onReorderDrop,
  onReorderDragEnd,
  onReorderKeyDown,
}: {
  scene: Scene;
  /** Position in the storyboard, 1-based. */
  index: number;
  pixelsPerSecond: number;
  selected: boolean;
  live: boolean;
  hidden: boolean;
  expanded: boolean;
  onSelect: (scene: Scene, modifiers: { shift?: boolean; additive?: boolean }) => void;
  onToggleHidden: (scene: Scene) => void;
  onToggleExpanded: (sceneId: string, expanded: boolean) => void;
  onDragStart: (scene: Scene, zone: DragZone, pointerX: number) => void;
  onDragMove: (scene: Scene, pointerX: number) => void;
  onDragEnd: (scene: Scene, pointerX: number) => void;
  onDragCancel: () => void;
  reorderPlacement: "before" | "after" | null;
  onReorderDragStart: (scene: Scene) => void;
  onReorderDragOver: (scene: Scene, placement: "before" | "after") => void;
  onReorderDrop: (scene: Scene, placement: "before" | "after") => void;
  onReorderDragEnd: () => void;
  onReorderKeyDown: (scene: Scene, direction: -1 | 1) => void;
}) {
  const Icon = hidden ? EyeOffIcon : EyeIcon;
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  const group = groupOf(scene);
  const end = scene.start + scene.duration;
  const inside = scene.elements.length + scene.unresolvedEffects;

  return (
    <div
      data-timeline-row={scene.id}
      data-reorder-placement={reorderPlacement ?? undefined}
      data-selected={selected || undefined}
      className={cn(
        "data-selected:bg-studio-accent/5 flex h-10 shrink-0 border-b",
        reorderPlacement === "before" && "border-t-2 border-t-sky-400",
        reorderPlacement === "after" && "border-b-2 border-b-violet-400",
      )}
    >
      <div
        style={TIMELINE_GUTTER_STYLE}
        className="bg-sidebar sticky left-0 z-20 flex shrink-0 items-center gap-1.5 border-r px-1.5"
      >
        <button
          type="button"
          onClick={() => onToggleExpanded(scene.id, expanded)}
          disabled={inside === 0}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${scene.id}`}
          aria-expanded={expanded}
          title={
            inside === 0
              ? "Nothing timed inside this scene"
              : `${inside} element${inside === 1 ? "" : "s"} and effects`
          }
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm disabled:opacity-25"
        >
          <Chevron className="size-3.5" />
        </button>
        <span
          className={cn(
            "text-muted-foreground w-3 shrink-0 text-center font-mono text-[10px]",
            selected && "text-studio-accent",
          )}
        >
          {index}
        </span>
        <button
          type="button"
          draggable
          data-timeline-reorder-id={scene.id}
          onClick={(event) => onSelect(scene, {
            shift: event.shiftKey,
            additive: event.metaKey || event.ctrlKey,
          })}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            onReorderKeyDown(scene, event.key === "ArrowUp" ? -1 : 1);
          }}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            onReorderDragStart(scene);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onReorderDragOver(scene, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
          }}
          onDrop={(event) => {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onReorderDrop(scene, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
          }}
          onDragEnd={onReorderDragEnd}
          title={`${scene.id} · ${scene.src ?? "index.html"}`}
          className={cn(
            "min-w-0 grow truncate text-left text-[11px]",
            selected ? "text-studio-accent font-medium" : "hover:text-foreground",
            hidden && "text-muted-foreground line-through",
          )}
        >
          {scene.id}
        </button>
        <button
          type="button"
          onClick={() => onToggleHidden(scene)}
          aria-label={`${hidden ? "Show" : "Hide"} ${scene.id} in the preview`}
          aria-pressed={!hidden}
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1"
        >
          <Icon className="size-3.5" />
        </button>
      </div>

      <div className="relative grow">
        <button
          type="button"
          data-timeline-scene-id={scene.id}
          aria-pressed={selected}
          onClick={(event) => {
            if (event.detail === 0) onSelect(scene, {});
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            onSelect(scene, {
              shift: event.shiftKey,
              additive: event.metaKey || event.ctrlKey,
            });
            onDragStart(scene, hitZone(event.clientX - bounds.left, bounds.width), event.clientX);
          }}
          onPointerMove={(event) => {
            onDragMove(scene, event.clientX);
          }}
          onPointerUp={(event) => {
            onDragEnd(scene, event.clientX);
          }}
          onPointerCancel={onDragCancel}
          title={`${formatTimecode(scene.start)} → ${formatTimecode(end)}`}
          className={cn(
            "absolute inset-y-1.5 flex touch-none items-center overflow-hidden rounded-sm border px-1.5 transition-colors",
            GROUP_STYLE[group] ?? GROUP_STYLE.scene,
            selected && "ring-studio-accent ring-2",
            live && !selected && "border-studio-accent",
            hidden && "opacity-35",
          )}
          style={{
            left: scene.start * pixelsPerSecond,
            // Never collapse to nothing: a 0.2s flash still has to be clickable.
            width: Math.max(scene.duration * pixelsPerSecond, 6),
          }}
        >
          <span className="text-foreground/85 truncate font-mono text-[10px]">
            {scene.duration}s
          </span>
        </button>
      </div>
    </div>
  );
});
