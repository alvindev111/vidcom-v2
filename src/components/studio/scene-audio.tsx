"use client";

import { EyeIcon, EyeOffIcon, PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  REVEAL_SOUNDS,
  TRANSITION_SOUNDS,
  type RevealSound,
  type SceneSettings,
  type TransitionSound,
} from "@/lib/studio/preview-settings";
import { playRevealSound, playTransitionSound } from "@/lib/studio/preview-sounds";
import { SelectField } from "./preview-controls";

const TRANSITION_OPTIONS = TRANSITION_SOUNDS.map(
  (name) => [name, title(name)] as const,
);
const REVEAL_OPTIONS = REVEAL_SOUNDS.map((name) => [name, title(name)] as const);

function title(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Per-scene sound design and visibility. The sounds are auditioned with the
 * WebAudio synth rather than rendered into the composition — they describe the
 * intent for the scene, and "Test" is how you hear it.
 */
export function SceneAudio({
  scene,
  onChange,
}: {
  scene: SceneSettings;
  onChange: (patch: Partial<SceneSettings>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Enter transition"
          value={scene.transitionSound}
          options={TRANSITION_OPTIONS}
          onChange={(transitionSound: TransitionSound) =>
            onChange({ transitionSound })
          }
        />
        <SelectField
          label="Element reveal"
          value={scene.revealSound}
          options={REVEAL_OPTIONS}
          onChange={(revealSound: RevealSound) => onChange({ revealSound })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => playTransitionSound(scene.transitionSound)}
        >
          <PlayIcon className="size-3" />
          Test transition
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => playRevealSound(scene.revealSound)}
        >
          <PlayIcon className="size-3" />
          Test reveal
        </Button>

        <Button
          variant={scene.hidden ? "outline" : "ghost"}
          size="sm"
          className={`ml-auto h-7 gap-1.5 text-xs ${
            scene.hidden ? "" : "text-destructive hover:text-destructive"
          }`}
          onClick={() => onChange({ hidden: !scene.hidden })}
        >
          {scene.hidden ? (
            <>
              <EyeIcon className="size-3" />
              Restore in preview
            </>
          ) : (
            <>
              <EyeOffIcon className="size-3" />
              Hide from preview
            </>
          )}
        </Button>
      </div>

      {scene.hidden ? (
        <p className="text-muted-foreground text-[11px]">
          Hidden in the preview only — the scene is still in{" "}
          <code className="font-mono">index.html</code> and still renders.
        </p>
      ) : null}
    </div>
  );
}
