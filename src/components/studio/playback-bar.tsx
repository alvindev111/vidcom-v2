"use client";

import {
  PauseIcon,
  PictureInPicture2Icon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatTimecode } from "@/lib/studio/format";

const RATES = [0.5, 1, 1.5, 2] as const;

export function PlaybackBar({
  duration,
  currentTime,
  paused,
  muted,
  playbackRate,
  disabled,
  onToggle,
  onSeek,
  onToggleMuted,
  onPlaybackRateChange,
}: {
  duration: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  playbackRate: number;
  disabled: boolean;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onToggleMuted: () => void;
  onPlaybackRateChange: (rate: number) => void;
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

      <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
        {formatTimecode(currentTime)} / {formatTimecode(duration)}
      </span>

      <Slider
        value={[currentTime]}
        max={duration || 1}
        step={0.05}
        disabled={disabled}
        onValueChange={([value]) => onSeek(value)}
        aria-label="Seek"
        className="grow [&_[data-slot=slider-range]]:bg-studio-accent [&_[data-slot=slider-thumb]]:border-studio-accent"
      />

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
