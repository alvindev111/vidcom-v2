import {
  COLOR_PALETTE_IDS,
  type ColorPaletteId,
  type PreviewSettingsDto,
  type PreviewSettingsPatchDto,
} from "@vidcom/contracts";

import { colorPaletteSelection, DEFAULT_COLOR_PALETTE_ID } from "./color-palettes";

const LIGHT_POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
const LIGHT_INTENSITIES = ["low", "medium", "high", "max"] as const;
const BACKGROUND_EFFECTS = ["none", "scan", "particles", "rings", "lorenz"] as const;
const TRANSITION_SOUNDS = [
  "gong", "rise", "bass", "chime", "sweep", "boom", "alarm", "chord", "ascending", "retro", "minimal", "dramatic",
] as const;
const REVEAL_SOUNDS = [
  "ping", "pop", "chime", "click", "bubble", "woosh", "sparkle", "drop", "tick", "bell", "blip", "snap",
] as const;
const THEME_VARIABLES = [
  "--primary", "--primary-light", "--accent", "--accent-light", "--background", "--surface",
  "--text", "--text-muted", "--success", "--info",
] as const;

const DEFAULT_PALETTE = colorPaletteSelection(DEFAULT_COLOR_PALETTE_ID);

/** Canonical preview settings used when a project has no backing file. */
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettingsDto = {
  tone: {
    enabled: false,
    colorMode: DEFAULT_PALETTE.tone.colorMode,
    backgroundColor: DEFAULT_PALETTE.tone.backgroundColor,
    backgroundFx: "none",
    mainLight: DEFAULT_PALETTE.tone.mainLight,
    mainLightPosition: "top-center",
    mainLightIntensity: "medium",
    softLight: DEFAULT_PALETTE.tone.softLight,
    softLightPosition: "bottom-right",
    softLightIntensity: "medium",
  },
  theme: DEFAULT_PALETTE.theme,
  bgm: { enabled: false, volume: 0.3, loop: true, track: null },
  subtitles: {
    enabled: true,
    override: false,
    color: DEFAULT_PALETTE.subtitles.color,
    activeColor: DEFAULT_PALETTE.subtitles.activeColor,
    fontSize: 72,
    bottom: 120,
  },
  scenes: {},
};

function oneOf<Value extends string>(value: unknown, allowed: readonly Value[], fallback: Value): Value {
  return allowed.includes(value as Value) ? (value as Value) : fallback;
}

function number(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function hex(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function paletteId(value: unknown): ColorPaletteId | null {
  return COLOR_PALETTE_IDS.includes(value as ColorPaletteId) ? value as ColorPaletteId : null;
}

function hasCustomColorPatch(patch: PreviewSettingsPatchDto): boolean {
  return patch.theme?.variables !== undefined
    || patch.tone?.backgroundColor !== undefined
    || patch.tone?.mainLight !== undefined
    || patch.tone?.softLight !== undefined
    || patch.subtitles?.color !== undefined
    || patch.subtitles?.activeColor !== undefined;
}

/** Normalizes arbitrary disk data into a complete preview settings value without throwing. */
export function normalizePreviewSettings(raw: unknown): PreviewSettingsDto {
  const input = (raw ?? {}) as Record<string, unknown>;
  const tone = (input.tone ?? {}) as Record<string, unknown>;
  const theme = (input.theme ?? {}) as Record<string, unknown>;
  const variables = (theme.variables ?? {}) as Record<string, unknown>;
  const bgm = (input.bgm ?? {}) as Record<string, unknown>;
  const track = bgm.track as { name?: unknown; path?: unknown } | null;
  const subtitles = (input.subtitles ?? {}) as Record<string, unknown>;
  const scenes = (input.scenes ?? {}) as Record<string, unknown>;
  const base = DEFAULT_PREVIEW_SETTINGS;
  return {
    tone: {
      enabled: bool(tone.enabled, base.tone.enabled),
      colorMode: oneOf(tone.colorMode, ["dark", "cream"], base.tone.colorMode),
      backgroundColor: hex(tone.backgroundColor, base.tone.backgroundColor),
      backgroundFx: oneOf(tone.backgroundFx, BACKGROUND_EFFECTS, base.tone.backgroundFx),
      mainLight: hex(tone.mainLight, base.tone.mainLight),
      mainLightPosition: oneOf(tone.mainLightPosition, LIGHT_POSITIONS, base.tone.mainLightPosition),
      mainLightIntensity: oneOf(tone.mainLightIntensity, LIGHT_INTENSITIES, base.tone.mainLightIntensity),
      softLight: hex(tone.softLight, base.tone.softLight),
      softLightPosition: oneOf(tone.softLightPosition, LIGHT_POSITIONS, base.tone.softLightPosition),
      softLightIntensity: oneOf(tone.softLightIntensity, LIGHT_INTENSITIES, base.tone.softLightIntensity),
    },
    theme: {
      paletteId: paletteId(theme.paletteId),
      variables: Object.fromEntries(
        THEME_VARIABLES.map((name) => [name, hex(variables[name], base.theme.variables[name])]),
      ) as PreviewSettingsDto["theme"]["variables"],
    },
    bgm: {
      enabled: bool(bgm.enabled, base.bgm.enabled),
      volume: number(bgm.volume, base.bgm.volume, 0, 1),
      loop: bool(bgm.loop, base.bgm.loop),
      track:
        typeof track?.path === "string"
          ? { name: typeof track.name === "string" ? track.name : track.path, path: track.path }
          : null,
    },
    subtitles: {
      enabled: bool(subtitles.enabled, base.subtitles.enabled),
      override: bool(subtitles.override, base.subtitles.override),
      color: hex(subtitles.color, base.subtitles.color),
      activeColor: hex(subtitles.activeColor, base.subtitles.activeColor),
      fontSize: number(subtitles.fontSize, base.subtitles.fontSize, 8, 200),
      bottom: number(subtitles.bottom, base.subtitles.bottom, 0, 900),
    },
    scenes: Object.fromEntries(
      Object.entries(scenes).map(([id, value]) => {
        const scene = (value ?? {}) as Record<string, unknown>;
        return [id, {
          transitionSound: oneOf(scene.transitionSound, TRANSITION_SOUNDS, "minimal"),
          revealSound: oneOf(scene.revealSound, REVEAL_SOUNDS, "ping"),
          hidden: bool(scene.hidden, false),
        }];
      }),
    ),
  };
}

/** Applies a strict boundary patch using section-level merge semantics. */
export function mergePreviewSettings(
  current: PreviewSettingsDto,
  patch: PreviewSettingsPatchDto,
): PreviewSettingsDto {
  const removedScenes = new Set(patch.scenesRemove ?? []);
  const selectedPalette = patch.theme?.paletteId
    ? colorPaletteSelection(patch.theme.paletteId)
    : undefined;
  const selectedPaletteId = selectedPalette?.theme.paletteId;
  const customColors = hasCustomColorPatch(patch);
  const nextPaletteId = customColors || patch.theme?.paletteId === null
    ? null
    : selectedPaletteId ?? current.theme.paletteId;
  return normalizePreviewSettings({
    tone: { ...current.tone, ...selectedPalette?.tone, ...patch.tone },
    theme: {
      paletteId: nextPaletteId,
      variables: {
        ...current.theme.variables,
        ...selectedPalette?.theme.variables,
        ...patch.theme?.variables,
      },
    },
    bgm: { ...current.bgm, ...patch.bgm },
    subtitles: { ...current.subtitles, ...selectedPalette?.subtitles, ...patch.subtitles },
    scenes: Object.fromEntries(
      Object.entries({ ...current.scenes, ...patch.scenes })
        .filter(([sceneId]) => !removedScenes.has(sceneId)),
    ),
  });
}

/** Serializes settings deterministically for hashing and atomic persistence. */
export function serializePreviewSettings(settings: PreviewSettingsDto): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
