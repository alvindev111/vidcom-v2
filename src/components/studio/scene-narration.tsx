"use client";

import { AudioWaveformIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Narration } from "@/lib/studio/types";

/**
 * TTS state of a scene. Regenerating is wired to the same endpoint a script edit
 * uses, so the two stay in sync; the "mock" badge is shown until a real wav
 * exists on disk (`hyperframes tts` needs Kokoro installed).
 */
export function SceneNarration({
  narration,
  scriptText,
  pending,
  onRegenerate,
}: {
  narration: Narration | null;
  /** Text that would be spoken if narration has not been generated yet. */
  scriptText: string | null;
  pending: boolean;
  onRegenerate: (text: string) => void;
}) {
  const text = narration?.text ?? scriptText;

  if (!text) {
    return (
      <p className="text-muted-foreground text-xs">
        No script in this scene, so there is nothing to voice yet.
      </p>
    );
  }

  return (
    <div className="bg-muted/40 flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <AudioWaveformIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="grow truncate text-xs">{text}</span>
        <span
          className={
            narration?.status === "generated"
              ? "bg-studio-accent/15 text-studio-accent rounded-full px-2 py-0.5 text-[10px] font-medium"
              : "bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium"
          }
        >
          {narration
            ? narration.status === "generated"
              ? "audio ready"
              : "mock · no audio"
            : "not generated"}
        </span>
      </div>

      {narration ? (
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[10px]">
          <dt>voice</dt>
          <dd>{narration.voice}</dd>
          <dt>file</dt>
          <dd>{narration.audioPath}</dd>
          <dt>run</dt>
          <dd className="break-all">{narration.command}</dd>
          <dt>revision</dt>
          <dd>{narration.revision}</dd>
        </dl>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        className="h-7 w-fit gap-1.5 text-xs"
        disabled={pending}
        onClick={() => onRegenerate(text)}
      >
        <RefreshCwIcon className="size-3" />
        {pending ? "Running TTS…" : "Regenerate TTS"}
      </Button>
    </div>
  );
}
