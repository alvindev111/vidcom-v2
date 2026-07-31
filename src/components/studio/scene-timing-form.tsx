"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Scene } from "@/lib/studio/types";

export function SceneTimingForm({
  scene,
  pending,
  onSave,
}: {
  scene: Scene;
  pending: boolean;
  onSave: (timing: {
    start: number;
    duration: number;
    trackIndex: number;
  }) => void;
}) {
  const [start, setStart] = React.useState(String(scene.start));
  const [duration, setDuration] = React.useState(String(scene.duration));
  const [track, setTrack] = React.useState(String(scene.trackIndex));

  // Re-seed when another scene is selected or the server sends new values.
  const seed = `${scene.id}:${scene.start}:${scene.duration}:${scene.trackIndex}`;
  const [seeded, setSeeded] = React.useState(seed);
  if (seeded !== seed) {
    setSeeded(seed);
    setStart(String(scene.start));
    setDuration(String(scene.duration));
    setTrack(String(scene.trackIndex));
  }

  const dirty =
    Number(start) !== scene.start ||
    Number(duration) !== scene.duration ||
    Number(track) !== scene.trackIndex;
  const valid = [start, duration, track].every(
    (value) => value.trim() !== "" && Number.isFinite(Number(value)),
  );

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          start: Number(start),
          duration: Number(duration),
          trackIndex: Number(track),
        });
      }}
    >
      <Field label="start (s)" value={start} onChange={setStart} />
      <Field label="duration (s)" value={duration} onChange={setDuration} />
      <Field label="track" value={track} onChange={setTrack} step="1" />
      <Button
        type="submit"
        size="sm"
        className="h-8 text-xs"
        disabled={!dirty || !valid || pending}
      >
        {pending ? "Saving…" : "Save timing"}
      </Button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  step = "0.1",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  step?: string;
}) {
  const id = `scene-${label.replace(/\W+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-muted-foreground text-[10px]">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-20 font-mono text-xs"
      />
    </div>
  );
}
