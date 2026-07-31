"use client";

import { ImageOffIcon, SparkleIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/studio/format";
import type { Scene } from "@/lib/studio/types";
import {
  frameUrl,
  groupOf,
  type SnapshotFrame,
} from "@/lib/studio/snapshots";

export function SceneCard({
  scene,
  index,
  frame,
  projectSlug,
  selected,
  live,
  onSelect,
}: {
  scene: Scene;
  /** Position in the storyboard, 1-based. */
  index: number;
  frame: SnapshotFrame | null;
  projectSlug: string;
  selected: boolean;
  live: boolean;
  onSelect: () => void;
}) {
  const end = scene.start + scene.duration;
  const group = groupOf(scene);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected || undefined}
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-md border text-left transition-colors",
        "hover:border-studio-accent/60",
        "data-selected:border-studio-accent data-selected:ring-studio-accent/30 data-selected:ring-2",
      )}
    >
      <span className="relative block aspect-video overflow-hidden bg-black">
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
        <span className="truncate text-xs font-medium">{scene.id}</span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {formatTimecode(scene.start)} → {formatTimecode(end)} ·{" "}
          {scene.duration}s
        </span>
      </span>
    </button>
  );
}
