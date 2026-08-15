"use client";

import * as React from "react";
import { MoonIcon, SunIcon, UploadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  BACKGROUND_FX,
  LIGHT_INTENSITIES,
  LIGHT_POSITIONS,
  THEME_VARIABLES,
  type BackgroundFxKey,
  type LightIntensityKey,
  type LightPositionKey,
  type PreviewSettings,
  type PreviewSettingsPatch,
} from "@/lib/studio/preview-settings";
import {
  ColorField,
  DotGroup,
  EditorCard,
  SelectField,
  SliderField,
  ToggleRow,
} from "./preview-controls";

const FX_OPTIONS = Object.entries(BACKGROUND_FX) as [BackgroundFxKey, string][];

const POSITION_OPTIONS = Object.entries(LIGHT_POSITIONS).map(
  ([key, position]) => [key as LightPositionKey, position.label] as const,
);

const INTENSITY_OPTIONS = Object.entries(LIGHT_INTENSITIES).map(
  ([key, intensity]) => [key as LightIntensityKey, intensity.label] as const,
);

const THEME_LABELS: Record<(typeof THEME_VARIABLES)[number], string> = {
  "--primary": "Primary",
  "--primary-light": "Primary light",
  "--accent": "Accent",
  "--accent-light": "Accent light",
  "--background": "Background",
  "--surface": "Surface",
  "--text": "Text",
  "--text-muted": "Muted text",
  "--success": "Success",
  "--info": "Info",
};

/**
 * Project-wide look and sound of the preview. Nothing here rewrites the
 * composition — the values land in `preview-settings.json` and are injected as
 * CSS (plus a tone overlay and a BGM track) when the preview document is built.
 */
export function PreviewEditor({
  settings,
  pending,
  onPatch,
  onUploadBgm,
}: {
  settings: PreviewSettings;
  pending: boolean;
  onPatch: (patch: PreviewSettingsPatch) => void;
  onUploadBgm: (file: File) => void;
}) {
  const { tone, theme, bgm, subtitles } = settings;
  const fileInput = React.useRef<HTMLInputElement>(null);

  // Sliders report every drag frame; the draft keeps the thumb responsive while
  // only the committed value is written to disk.
  const [draft, setDraft] = React.useState<Record<string, number>>({});
  const live = (key: string, saved: number) => draft[key] ?? saved;
  const setLive = (key: string, value: number) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const commit = (key: string, patch: PreviewSettingsPatch) => {
    setDraft((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    onPatch(patch);
  };

  return (
    <div className="grid grid-cols-1 gap-3 p-4 2xl:grid-cols-2">
      <EditorCard title="Tone & lighting">
        <ToggleRow
          label="Apply lighting overlay"
          checked={tone.enabled}
          onChange={(enabled) => onPatch({ tone: { enabled } })}
        />
        <p className="text-muted-foreground text-[11px]">
          {tone.enabled
            ? `Blending ${tone.colorMode === "cream" ? "multiply — for a light composition" : "screen — for a dark composition"}. Pick the mode that matches the frame, or the image blows out.`
            : "Off — the composition renders exactly as authored."}
        </p>

        <div className="flex items-end gap-2">
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={tone.colorMode}
            onValueChange={(value) =>
              value && onPatch({ tone: { colorMode: value as "dark" | "cream" } })
            }
          >
            <ToggleGroupItem value="dark" className="h-8 gap-1.5 px-2 text-xs">
              <MoonIcon className="size-3.5" />
              Dark
            </ToggleGroupItem>
            <ToggleGroupItem value="cream" className="h-8 gap-1.5 px-2 text-xs">
              <SunIcon className="size-3.5" />
              Cream
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="grow">
            <SelectField
              label="Background animation"
              value={tone.backgroundFx}
              options={FX_OPTIONS}
              onChange={(backgroundFx) => onPatch({ tone: { backgroundFx } })}
            />
          </div>
        </div>

        <ColorField
          label="Background"
          value={tone.backgroundColor}
          onChange={(backgroundColor) => onPatch({ tone: { backgroundColor } })}
        />

        <Separator />

        <div className="grid grid-cols-2 gap-2">
          <ColorField
            label="Key light"
            value={tone.mainLight}
            onChange={(mainLight) => onPatch({ tone: { mainLight } })}
          />
          <ColorField
            label="Fill light"
            value={tone.softLight}
            onChange={(softLight) => onPatch({ tone: { softLight } })}
          />
        </div>

        <DotGroup
          label="Key light"
          hint="position"
          value={tone.mainLightPosition}
          options={POSITION_OPTIONS}
          columns={3}
          color={tone.mainLight}
          onChange={(mainLightPosition) => onPatch({ tone: { mainLightPosition } })}
        />
        <DotGroup
          label="Key light"
          hint="intensity"
          value={tone.mainLightIntensity}
          options={INTENSITY_OPTIONS}
          columns={4}
          color={tone.mainLight}
          onChange={(mainLightIntensity) =>
            onPatch({ tone: { mainLightIntensity } })
          }
        />

        <DotGroup
          label="Fill light"
          hint="position"
          value={tone.softLightPosition}
          options={POSITION_OPTIONS}
          columns={3}
          color={tone.softLight}
          onChange={(softLightPosition) => onPatch({ tone: { softLightPosition } })}
        />
        <DotGroup
          label="Fill light"
          hint="intensity"
          value={tone.softLightIntensity}
          options={INTENSITY_OPTIONS}
          columns={4}
          color={tone.softLight}
          onChange={(softLightIntensity) =>
            onPatch({ tone: { softLightIntensity } })
          }
        />
      </EditorCard>

      <div className="flex flex-col gap-3">
        <EditorCard title="Palette">
          <p className="text-muted-foreground text-[11px]">
            Published on <code className="font-mono">:root</code> of the preview
            and every sub-composition.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {THEME_VARIABLES.map((name) => (
              <ColorField
                key={name}
                label={THEME_LABELS[name]}
                value={theme.variables[name]}
                onChange={(value) =>
                  onPatch({ theme: { variables: { [name]: value } } })
                }
              />
            ))}
          </div>
        </EditorCard>

        <EditorCard title="Background music">
          <ToggleRow
            label="Play a track under the composition"
            checked={bgm.enabled}
            onChange={(enabled) => onPatch({ bgm: { enabled } })}
          />

          <SliderField
            label="Volume"
            value={live("volume", bgm.volume)}
            min={0}
            max={1}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(value) => setLive("volume", value)}
            onCommit={(value) => commit("volume", { bgm: { volume: value } })}
          />

          <ToggleRow
            label="Loop until the video ends"
            checked={bgm.loop}
            onChange={(loop) => onPatch({ bgm: { loop } })}
          />

          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUploadBgm(file);
              event.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={pending}
            onClick={() => fileInput.current?.click()}
          >
            <UploadIcon className="size-3.5" />
            Upload track
          </Button>

          <p className="text-muted-foreground truncate font-mono text-[10px]">
            {bgm.track
              ? bgm.track.path
              : "No track yet — the runtime plays it on the timeline once uploaded."}
          </p>
        </EditorCard>

        <EditorCard title="Subtitles">
          <ToggleRow
            label="Show subtitles"
            checked={subtitles.enabled}
            onChange={(enabled) => onPatch({ subtitles: { enabled } })}
          />
          <ToggleRow
            label="Take over caption styling"
            checked={subtitles.override}
            onChange={(override) => onPatch({ subtitles: { override } })}
          />
          <p className="text-muted-foreground text-[11px]">
            {subtitles.override
              ? "Forced onto every caption element, beating the composition's own CSS."
              : "Published as CSS variables only — a composition that hard-codes its captions keeps them."}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <ColorField
              label="Base"
              value={subtitles.color}
              onChange={(color) => onPatch({ subtitles: { color } })}
            />
            <ColorField
              label="Active word"
              value={subtitles.activeColor}
              onChange={(activeColor) => onPatch({ subtitles: { activeColor } })}
            />
          </div>

          <SliderField
            label="Font size"
            value={live("fontSize", subtitles.fontSize)}
            min={8}
            max={200}
            format={(value) => `${value}px`}
            onChange={(value) => setLive("fontSize", value)}
            onCommit={(value) =>
              commit("fontSize", { subtitles: { fontSize: value } })
            }
          />
          <SliderField
            label="Distance from the bottom"
            value={live("bottom", subtitles.bottom)}
            min={0}
            max={900}
            format={(value) => `${value}px`}
            onChange={(value) => setLive("bottom", value)}
            onCommit={(value) => commit("bottom", { subtitles: { bottom: value } })}
          />
        </EditorCard>
      </div>
    </div>
  );
}
