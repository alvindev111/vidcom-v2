"use client";

import * as React from "react";
import { EyeOffIcon, ImageOffIcon, SparkleIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/studio/format";
import type { Scene } from "@/lib/studio/types";
import {
  frameUrl,
  groupOf,
  type SnapshotFrame,
} from "@/lib/studio/snapshots";

/**
 * Memoized: the playhead crossing a scene boundary re-renders the storyboard,
 * and only the two cards whose `live` flag flipped have anything new to paint.
 * `onSelect` takes the scene so the handler can stay stable across renders.
 */
export const SceneCard = React.memo(function SceneCard({
  scene,
  index,
  frame,
  projectSlug,
  selected,
  live,
  hidden,
  onSelect,
  dropPlacement,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onReorderKeyDown,
}: {
  scene: Scene;
  /** Position in the storyboard, 1-based. */
  index: number;
  frame: SnapshotFrame | null;
  projectSlug: string;
  selected: boolean;
  live: boolean;
  /** Hidden from the preview by the scene's preview settings. */
  hidden: boolean;
  onSelect: (scene: Scene, modifiers: { shift?: boolean; additive?: boolean }) => void;
  dropPlacement: "before" | "after" | null;
  onDragStart: (scene: Scene) => void;
  onDragOver: (scene: Scene, placement: "before" | "after") => void;
  onDrop: (scene: Scene, placement: "before" | "after") => void;
  onDragEnd: () => void;
  onReorderKeyDown: (scene: Scene, direction: -1 | 1) => void;
}) {
  const end = scene.start + scene.duration;
  const group = groupOf(scene);

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart(scene);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onDragOver(scene, event.clientX < bounds.left + bounds.width / 2 ? "before" : "after");
      }}
      onDrop={(event) => {
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onDrop(scene, event.clientX < bounds.left + bounds.width / 2 ? "before" : "after");
      }}
      onDragEnd={onDragEnd}
      data-selected={selected || undefined}
      className={cn(
        "group/card relative flex flex-col overflow-hidden rounded-md border text-left transition-colors",
        "hover:border-studio-accent/60",
        "data-selected:border-studio-accent data-selected:ring-studio-accent/30 data-selected:ring-2",
        dropPlacement === "before" && "ring-2 ring-sky-400 ring-offset-1",
        dropPlacement === "after" && "ring-2 ring-violet-400 ring-offset-1",
      )}
    >
      <button
        type="button"
        onClick={(event) => onSelect(scene, {
          shift: event.shiftKey,
          additive: event.metaKey || event.ctrlKey,
        })}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          onReorderKeyDown(scene, event.key === "ArrowLeft" ? -1 : 1);
        }}
        className="contents"
        aria-label={`Select ${scene.id}; drag or press Alt+Arrow to reorder`}
      >
      <span
        className={cn(
          "relative block aspect-video overflow-hidden bg-black",
          hidden && "opacity-40 grayscale",
        )}
      >
        {frame ? (
          // Frame captured by `hyperframes snapshot`, served from the project.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={frameUrl(projectSlug, frame)}
            alt={`Frame at ${frame.seconds}s`}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-muted-foreground absolute inset-0 grid place-items-center gap-1 text-center">
            <ImageOffIcon className="mx-auto size-4" />
          </span>
        )}

        <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
          {index}
        </span>

        {group !== "scene" ? (
          <span className="bg-studio-accent/85 text-studio-accent-foreground absolute top-1 right-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
            <SparkleIcon className="size-2.5" />
            {group}
          </span>
        ) : null}

        {live ? (
          <span className="bg-studio-accent absolute bottom-1 right-1 size-2 rounded-full ring-2 ring-black/40" />
        ) : null}
      </span>

      <span className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="flex items-center gap-1.5 truncate text-xs font-medium">
          {hidden ? (
            <EyeOffIcon className="text-muted-foreground size-3 shrink-0" />
          ) : null}
          {scene.id}
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {formatTimecode(scene.start)} → {formatTimecode(end)} ·{" "}
          {scene.duration}s
        </span>
      </span>
      </button>
    </div>
  );
});
