"use client";

import * as React from "react";
import {
  AudioWaveformIcon,
  FilmIcon,
  ImageIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { countStrandedTweens, measureElementWindow } from "@vidcom/contracts";

import { formatTimecode } from "@/lib/studio/format";
import type { RootTrack, Scene, SceneElement } from "@/lib/studio/types";
import { cn } from "@/lib/utils";
import { TIMELINE_GUTTER_STYLE } from "./timeline-constants";

const KIND_ICON = {
  image: ImageIcon,
  video: FilmIcon,
  audio: AudioWaveformIcon,
  element: SquareIcon,
} as const;

/** A tween's property group decides its colour, so motion reads at a glance. */
const GROUP_COLOR: Record<string, string> = {
  position: "bg-sky-500/70",
  scale: "bg-violet-500/70",
  size: "bg-emerald-500/70",
  rotation: "bg-amber-500/70",
  visual: "bg-pink-500/70",
};

export function Row({
  depth,
  label,
  icon,
  children,
}: {
  depth: 1 | 2;
  label: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex shrink-0 border-b", depth === 1 ? "h-7" : "h-6")}>
      <div
        style={TIMELINE_GUTTER_STYLE}
        className={cn(
          "bg-sidebar sticky left-0 z-20 flex shrink-0 items-center gap-1.5 border-r",
          depth === 1 ? "pr-1.5 pl-7" : "pr-1.5 pl-11",
        )}
      >
        {icon}
        <span className="text-muted-foreground min-w-0 truncate text-[10px]">
          {label}
        </span>
      </div>
      <div className="relative grow">{children}</div>
    </div>
  );
}

/**
 * The inside of a scene: one row per element, and under it one row per tween.
 *
 * Times are authored relative to the scene, so every bar is offset by the
 * scene's own start — a tween at 1.86s inside a scene that begins at 4s belongs
 * under 5.86s on the composition's ruler.
 */
/**
 * Rows of the entry document's own track — the A-roll and the tweens that move
 * it. Same shape as a scene's expanded rows, but timed against the composition
 * itself, so there is no scene offset and nothing can be stranded past a clip.
 */
export const TimelineRootRows = React.memo(function TimelineRootRows({
  track,
  pixelsPerSecond,
}: {
  track: RootTrack;
  pixelsPerSecond: number;
}) {
  return (
    <>
      {track.elements.map((element) => (
        <ElementRows
          key={element.id}
          element={element}
          sceneStart={0}
          sceneDuration={track.duration}
          pixelsPerSecond={pixelsPerSecond}
        />
      ))}

      {track.unresolvedEffects > 0 ? (
        <Row
          depth={1}
          icon={<TriangleAlertIcon className="size-3 shrink-0 text-amber-500" />}
          label={`${track.unresolvedEffects} dynamic`}
        >
          <span className="text-muted-foreground absolute inset-y-0 left-1.5 flex items-center text-[10px]">
            built in a loop at runtime — no static start time to place
          </span>
        </Row>
      ) : null}
    </>
  );
});

/**
 * Memoized: these rows are the bulk of the timeline's DOM — one per element and
 * one per tween — and nothing in them depends on the playhead.
 */
export const TimelineElementRows = React.memo(function TimelineElementRows({
  scene,
  pixelsPerSecond,
}: {
  scene: Scene;
  pixelsPerSecond: number;
}) {
  // The runtime hides a scene once its clip window closes, so a tween authored
  // past that point never runs. Counting them turns a bar that looks like a
  // rendering glitch into the authoring bug it actually is.
  const stranded = countStrandedTweens(scene.elements, scene.duration);

  return (
    <>
      {scene.elements.map((element) => (
        <ElementRows
          key={element.id}
          element={element}
          sceneStart={scene.start}
          sceneDuration={scene.duration}
          pixelsPerSecond={pixelsPerSecond}
        />
      ))}

      {stranded > 0 ? (
        <Row
          depth={1}
          icon={<TriangleAlertIcon className="size-3 shrink-0 text-amber-500" />}
          label={`${stranded} past ${scene.duration}s`}
        >
          <span className="text-muted-foreground absolute inset-y-0 left-1.5 flex items-center text-[10px]">
            starts after this scene&apos;s clip ends — never plays. Extend
            <code className="mx-1 font-mono">data-duration</code>or move the tween.
          </span>
        </Row>
      ) : null}

      {scene.unresolvedEffects > 0 ? (
        <Row
          depth={1}
          icon={<TriangleAlertIcon className="size-3 shrink-0 text-amber-500" />}
          label={`${scene.unresolvedEffects} dynamic`}
        >
          <span className="text-muted-foreground absolute inset-y-0 left-1.5 flex items-center text-[10px]">
            built in a loop at runtime — no static start time to place
          </span>
        </Row>
      ) : null}

      {scene.elements.length === 0 && scene.unresolvedEffects === 0 ? (
        <Row depth={1} label="no timed elements">
          <span className="text-muted-foreground absolute inset-y-0 left-1.5 flex items-center text-[10px]">
            nothing in this scene carries its own timing or a GSAP tween
          </span>
        </Row>
      ) : null}
    </>
  );
});

const ElementRows = React.memo(function ElementRows({
  element,
  sceneStart,
  sceneDuration,
  pixelsPerSecond,
}: {
  element: SceneElement;
  sceneStart: number;
  /** Clip length of the owning scene — the point past which nothing plays. */
  sceneDuration: number;
  pixelsPerSecond: number;
}) {
  const Icon = KIND_ICON[element.kind];

  // An element with no clip timing still has a lifespan on screen — the span its
  // tweens cover. Drawn faintly so it never reads as an authored slot.
  const { start, span, inWindow, overrun } = measureElementWindow(element, sceneDuration);
  const authored = element.start !== null;

  return (
    <>
      <Row
        depth={1}
        icon={<Icon className="text-muted-foreground size-3 shrink-0" />}
        label={element.label}
      >
        <span
          title={[
            authored
              ? `${formatTimecode(sceneStart + start)} → ${formatTimecode(sceneStart + start + span)}`
              : "no authored timing — span of its tweens",
            element.src,
          ]
            .filter(Boolean)
            .join(" · ")}
          className={cn(
            "absolute inset-y-1.5 rounded-sm",
            authored
              ? "bg-studio-accent/20 border-studio-accent/40 border"
              : "bg-muted-foreground/10 border-muted-foreground/20 border border-dashed",
          )}
          style={{
            left: (sceneStart + start) * pixelsPerSecond,
            width: Math.max(inWindow * pixelsPerSecond, 4),
          }}
        />

        {/* The part of the span the scene's clip never reaches, drawn separately
            so the row shows both what plays and what is stranded. */}
        {overrun > 0 ? (
          <span
            title={`extends ${overrun.toFixed(2)}s past this scene's ${sceneDuration}s clip — that part never plays`}
            className="absolute inset-y-2 rounded-sm border border-dashed border-amber-500/60 bg-amber-500/10"
            style={{
              left: (sceneStart + Math.max(start, sceneDuration)) * pixelsPerSecond,
              width: Math.max(overrun * pixelsPerSecond, 3),
            }}
          />
        ) : null}
      </Row>

      {element.effects.map((effect) => {
        const stranded = effect.start >= sceneDuration;
        return (
          <Row
            key={effect.id}
            depth={2}
            icon={
              stranded ? (
                <TriangleAlertIcon className="size-2.5 shrink-0 text-amber-500" />
              ) : undefined
            }
            label={
              <>
                {effect.method}
                {effect.ease ? (
                  <span className="opacity-60"> · {effect.ease}</span>
                ) : null}
              </>
            }
          >
            <span
              title={
                stranded
                  ? `${effect.method} at ${effect.start}s — after this scene's ${sceneDuration}s clip, so it never plays`
                  : `${effect.method} ${effect.propertyGroup ?? ""} ${formatTimecode(
                      sceneStart + effect.start,
                    )} +${effect.duration}s${effect.ease ? ` · ${effect.ease}` : ""}`
              }
              className={cn(
                "absolute inset-y-1.5 rounded-full",
                stranded
                  ? "border border-dashed border-amber-500/70 bg-amber-500/20"
                  : (GROUP_COLOR[effect.propertyGroup ?? ""] ??
                    "bg-studio-accent/60"),
              )}
              style={{
                left: (sceneStart + effect.start) * pixelsPerSecond,
                // A `set` has zero duration but still has to be visible.
                width: Math.max(effect.duration * pixelsPerSecond, 3),
              }}
            />
          </Row>
        );
      })}
    </>
  );
});
