"use client";

import { PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { formatTimecode } from "@/lib/studio/format";
import type { SceneSettings } from "@/lib/studio/preview-settings";
import type { Scene, SceneScriptLine } from "@/lib/studio/types";
import { SceneAudio } from "./scene-audio";
import { SceneMediaList } from "./scene-media-list";
import { SceneNarration } from "./scene-narration";
import { SceneScriptEditor } from "./scene-script-editor";
import { SceneTimingForm } from "./scene-timing-form";

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
        {title}
        {count != null ? ` · ${count}` : ""}
      </h3>
      {children}
    </section>
  );
}

export function SceneDetail({
  scene,
  settings,
  transitions,
  pending,
  error,
  onSeek,
  onSaveTiming,
  onSaveScriptLine,
  onRegenerateTts,
  onSaveSettings,
}: {
  scene: Scene;
  /** Preview-only settings for this scene: sound design and visibility. */
  settings: SceneSettings;
  /** Transition scenes of the whole composition, for context. */
  transitions: Scene[];
  pending: boolean;
  error: string | null;
  onSeek: (seconds: number) => void;
  onSaveTiming: (timing: {
    start: number;
    duration: number;
    trackIndex: number;
  }) => void;
  onSaveScriptLine: (line: SceneScriptLine, text: string) => void;
  onRegenerateTts: (text: string) => void;
  onSaveSettings: (patch: Partial<SceneSettings>) => void;
}) {
  const end = scene.start + scene.duration;
  const overlapping = transitions.filter(
    (item) =>
      item.id !== scene.id &&
      item.start < end &&
      item.start + item.duration > scene.start,
  );

  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{scene.id}</h2>
            <p className="text-muted-foreground truncate font-mono text-[11px]">
              {scene.src ?? "inline in index.html"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 shrink-0 gap-1.5 text-xs"
            onClick={() => onSeek(scene.start)}
          >
            <PlayIcon className="size-3" />
            Go to {formatTimecode(scene.start)}
          </Button>
        </div>

        <SceneTimingForm
          scene={scene}
          pending={pending}
          onSave={onSaveTiming}
        />

        {error ? (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </header>

      <Separator />

      <Section title="Images & media" count={scene.media.length}>
        <SceneMediaList media={scene.media} />
      </Section>

      <Separator />

      <Section title="Scene sound">
        <SceneAudio scene={settings} onChange={onSaveSettings} />
      </Section>

      <Separator />

      <Section title="Transition">
        {scene.isTransition ? (
          <div className="border-studio-accent/40 bg-studio-accent/5 rounded-md border p-3">
            <p className="text-sm font-medium">
              {scene.block?.title ?? scene.block?.name}
            </p>
            {scene.block?.description ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {scene.block.description}
              </p>
            ) : null}
            <p className="text-muted-foreground mt-2 font-mono text-[10px]">
              block {scene.block?.name}
              {scene.block?.tags.length
                ? ` · ${scene.block.tags.join(", ")}`
                : ""}
            </p>
          </div>
        ) : overlapping.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {overlapping.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-xs">
                <span className="bg-studio-accent size-1.5 rounded-full" />
                <span className="font-medium">
                  {item.block?.title ?? item.id}
                </span>
                <span className="text-muted-foreground font-mono text-[10px]">
                  {formatTimecode(item.start)} →{" "}
                  {formatTimecode(item.start + item.duration)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-2 text-[11px]"
                  onClick={() => onSeek(item.start)}
                >
                  Preview
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">
            No transition overlaps this scene. Install one with{" "}
            <code className="font-mono">hyperframes add &lt;block&gt;</code> and
            mount it with a{" "}
            <code className="font-mono">data-composition-src</code>.
          </p>
        )}
      </Section>

      <Separator />

      <Section title="Script" count={scene.script.length}>
        <SceneScriptEditor
          script={scene.script}
          pending={pending}
          onSave={onSaveScriptLine}
        />
      </Section>

      <Separator />

      <Section title="Narration (TTS)">
        <SceneNarration
          narration={scene.narration}
          scriptText={scene.script[0]?.text ?? null}
          pending={pending}
          onRegenerate={onRegenerateTts}
        />
      </Section>
    </div>
  );
}
