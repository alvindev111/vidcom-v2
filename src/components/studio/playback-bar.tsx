"use client";

import {
  PauseIcon,
  PictureInPicture2Icon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import type { PreviewAudioState } from "@/lib/studio/preview-bridge";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { TimeReadout, useCurrentTime } from "./player-time";

const RATES = [0.5, 1, 1.5, 2] as const;

/**
 * The parts that move with the clock, split out of the bar.
 *
 * The transport ticks ten times a second; keeping the subscription down here
 * means those ticks re-render a slider and a timecode rather than the whole bar
 * and its buttons.
 */
function Scrubber({
  duration,
  disabled,
  onSeek,
}: {
  duration: number;
  disabled: boolean;
  onSeek: (seconds: number) => void;
}) {
  const currentTime = useCurrentTime();

  return (
    <Slider
      value={[currentTime]}
      max={duration || 1}
      step={0.05}
      disabled={disabled}
      onValueChange={([value]) => onSeek(value)}
      aria-label="Seek"
      className="grow [&_[data-slot=slider-range]]:bg-studio-accent [&_[data-slot=slider-thumb]]:border-studio-accent"
    />
  );
}

export function PlaybackBar({
  duration,
  frameRate,
  paused,
  muted,
  playbackRate,
  disabled,
  onToggle,
  onSeek,
  onToggleMuted,
  onPlaybackRateChange,
  audioState,
  audioError,
}: {
  duration: number;
  frameRate: number;
  paused: boolean;
  muted: boolean;
  playbackRate: number;
  disabled: boolean;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onToggleMuted: () => void;
  onPlaybackRateChange: (rate: number) => void;
  audioState: PreviewAudioState;
  audioError: string | null;
}) {
  const cycleRate = () => {
    const index = RATES.indexOf(playbackRate as (typeof RATES)[number]);
    onPlaybackRateChange(RATES[(index + 1) % RATES.length]);
  };

  return (
    <div className="bg-sidebar flex h-11 shrink-0 items-center gap-3 border-t px-3">
      <Button
        variant="secondary"
        size="icon"
        className="size-7 rounded-full"
        aria-label={paused ? "Play" : "Pause"}
        disabled={disabled}
        onClick={onToggle}
      >
        {paused ? (
          <PlayIcon className="size-3.5" />
        ) : (
          <PauseIcon className="size-3.5" />
        )}
      </Button>

      <TimeReadout
        duration={duration}
        frameRate={frameRate}
        className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums"
      />

      {audioState === "activation-required" || audioState === "error" ? (
        <span className="max-w-52 truncate text-[10px] text-amber-500" role="status" title={audioError ?? undefined}>
          {audioState === "activation-required"
            ? "Click Enable audio in the preview"
            : `${audioError ?? "Preview audio failed"}. Fix the media or reload, then press Play.`}
        </span>
      ) : null}

      <Scrubber duration={duration} disabled={disabled} onSeek={onSeek} />

      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={muted ? "Unmute" : "Mute"}
        disabled={disabled}
        onClick={onToggleMuted}
      >
        {muted ? (
          <VolumeXIcon className="size-4" />
        ) : (
          <Volume2Icon className="size-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 font-mono text-xs"
        aria-label="Playback rate"
        disabled={disabled}
        onClick={cycleRate}
      >
        {playbackRate}x
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Pop out preview"
      >
        <PictureInPicture2Icon className="size-4" />
      </Button>
    </div>
  );
}
