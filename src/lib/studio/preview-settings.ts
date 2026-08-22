/**
 * Preview settings — the knobs the Video Scene tab exposes on top of the
 * authored composition. They live in `preview-settings.json` next to the
 * project's `index.html` and are applied by injecting CSS (plus a tone overlay
 * and a BGM element) into the preview document, so the composition source is
 * never rewritten by a colour or volume change.
 */

export const LIGHT_POSITIONS = {
  "top-left": { label: "Top left", x: "18%", y: "20%" },
  "top-center": { label: "Top center", x: "50%", y: "18%" },
  "top-right": { label: "Top right", x: "82%", y: "20%" },
  "center-left": { label: "Center left", x: "18%", y: "50%" },
  center: { label: "Center", x: "50%", y: "50%" },
  "center-right": { label: "Center right", x: "82%", y: "50%" },
  "bottom-left": { label: "Bottom left", x: "18%", y: "78%" },
  "bottom-center": { label: "Bottom center", x: "50%", y: "80%" },
  "bottom-right": { label: "Bottom right", x: "82%", y: "78%" },
} as const;

export const LIGHT_INTENSITIES = {
  low: { label: "Soft", alpha: 0.14 },
  medium: { label: "Medium", alpha: 0.22 },
  high: { label: "Strong", alpha: 0.3 },
  max: { label: "Blazing", alpha: 0.4 },
} as const;

export const BACKGROUND_FX = {
  none: "Off",
  scan: "Scan lines",
  particles: "Particles",
  rings: "Rings",
  lorenz: "Lorenz",
} as const;

/** Synthesised in the browser by `preview-sounds.ts` — no audio files needed. */
export const TRANSITION_SOUNDS = [
  "gong",
  "rise",
  "bass",
  "chime",
  "sweep",
  "boom",
  "alarm",
  "chord",
  "ascending",
  "retro",
  "minimal",
  "dramatic",
] as const;

export const REVEAL_SOUNDS = [
  "ping",
  "pop",
  "chime",
  "click",
  "bubble",
  "woosh",
  "sparkle",
  "drop",
  "tick",
  "bell",
  "blip",
  "snap",
] as const;

export type LightPositionKey = keyof typeof LIGHT_POSITIONS;
export type LightIntensityKey = keyof typeof LIGHT_INTENSITIES;
export type BackgroundFxKey = keyof typeof BACKGROUND_FX;
export type TransitionSound = (typeof TRANSITION_SOUNDS)[number];
export type RevealSound = (typeof REVEAL_SOUNDS)[number];
export const MOTION_PRESETS = ["none", "drift", "focus", "pulse", "wipe"] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];

export interface ToneSettings {
  /**
   * Draw the lighting overlay at all. Off by default, and deliberately so: the
   * overlay is a full-frame blend layer, and a composition that never asked for
   * one must render exactly as authored. Left on by default it washed a
   * cream-background project to white.
   */
  enabled: boolean;
  colorMode: "dark" | "cream";
  backgroundColor: string;
  backgroundFx: BackgroundFxKey;
  mainLight: string;
  mainLightPosition: LightPositionKey;
  mainLightIntensity: LightIntensityKey;
  softLight: string;
  softLightPosition: LightPositionKey;
  softLightIntensity: LightIntensityKey;
}

export interface ThemeSettings {
  /** Bundled palette selection, or null after an individual color override. */
  paletteId: string | null;
  /** CSS custom properties published on `:root` of every preview document. */
  variables: Record<string, string>;
}

export interface BgmSettings {
  enabled: boolean;
  volume: number;
  loop: boolean;
  /** Project-relative path of an uploaded track, or null when none. */
  track: { name: string; path: string } | null;
}

export interface SubtitleSettings {
  enabled: boolean;
  /**
   * Force the values below onto anything that looks like a caption, beating the
   * composition's own rules. Off by default: a composition that already styles
   * its captions should keep its design until the override is asked for.
   */
  override: boolean;
  color: string;
  activeColor: string;
  fontSize: number;
  bottom: number;
}

export interface SceneSettings {
  transitionSound: TransitionSound;
  revealSound: RevealSound;
  motionPreset: MotionPreset;
  /** Hidden scenes stay in the source but are not drawn in the preview. */
  hidden: boolean;
}

export interface PreviewSettings {
  tone: ToneSettings;
  theme: ThemeSettings;
  bgm: BgmSettings;
  subtitles: SubtitleSettings;
  scenes: Record<string, SceneSettings>;
}

export const THEME_VARIABLES = [
  "--primary",
  "--primary-light",
  "--accent",
  "--accent-light",
  "--background",
  "--surface",
  "--text",
  "--text-muted",
  "--success",
  "--info",
] as const;

export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  tone: {
    enabled: false,
    colorMode: "cream",
    backgroundColor: "#F9F7F7",
    backgroundFx: "none",
    mainLight: "#3F72AF",
    mainLightPosition: "top-center",
    mainLightIntensity: "medium",
    softLight: "#112D4E",
    softLightPosition: "bottom-right",
    softLightIntensity: "medium",
  },
  theme: {
    paletteId: "clean-slate",
    variables: {
      "--primary": "#3F72AF",
      "--primary-light": "#B2C4DC",
      "--accent": "#112D4E",
      "--accent-light": "#AFB6C1",
      "--background": "#F9F7F7",
      "--surface": "#DBE2EF",
      "--text": "#112D4E",
      "--text-muted": "#7C8A9C",
      "--success": "#44CD76",
      "--info": "#112D4E",
    },
  },
  bgm: { enabled: false, volume: 0.3, loop: true, track: null },
  subtitles: {
    enabled: true,
    override: false,
    // Sized for the 1920×1080 canvas these compositions author against, not for
    // a web page — a caption at 18px is invisible in a 1080p frame.
    color: "#112D4E",
    activeColor: "#112D4E",
    fontSize: 72,
    bottom: 120,
  },
  scenes: {},
};

export const DEFAULT_SCENE_SETTINGS: SceneSettings = {
  transitionSound: "minimal",
  revealSound: "ping",
  motionPreset: "none",
  hidden: false,
};

const HEX = /^#[0-9a-f]{6}$/i;

function hex(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX.test(value) ? value : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Read whatever is on disk (or came off the wire) into a complete, safe object. */
export function normalizePreviewSettings(raw: unknown): PreviewSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const base = DEFAULT_PREVIEW_SETTINGS;

  const tone = (input.tone ?? {}) as Record<string, unknown>;
  const theme = (input.theme ?? {}) as Record<string, unknown>;
  const bgm = (input.bgm ?? {}) as Record<string, unknown>;
  const subtitles = (input.subtitles ?? {}) as Record<string, unknown>;
  const scenes = (input.scenes ?? {}) as Record<string, unknown>;

  const themeVariables = (theme.variables ?? {}) as Record<string, unknown>;
  const track = bgm.track as { name?: unknown; path?: unknown } | null;

  return {
    tone: {
      enabled: bool(tone.enabled, base.tone.enabled),
      colorMode: oneOf(tone.colorMode, ["dark", "cream"], base.tone.colorMode),
      backgroundColor: hex(tone.backgroundColor, base.tone.backgroundColor),
      backgroundFx: oneOf(
        tone.backgroundFx,
        Object.keys(BACKGROUND_FX) as BackgroundFxKey[],
        base.tone.backgroundFx,
      ),
      mainLight: hex(tone.mainLight, base.tone.mainLight),
      mainLightPosition: oneOf(
        tone.mainLightPosition,
        Object.keys(LIGHT_POSITIONS) as LightPositionKey[],
        base.tone.mainLightPosition,
      ),
      mainLightIntensity: oneOf(
        tone.mainLightIntensity,
        Object.keys(LIGHT_INTENSITIES) as LightIntensityKey[],
        base.tone.mainLightIntensity,
      ),
      softLight: hex(tone.softLight, base.tone.softLight),
      softLightPosition: oneOf(
        tone.softLightPosition,
        Object.keys(LIGHT_POSITIONS) as LightPositionKey[],
        base.tone.softLightPosition,
      ),
      softLightIntensity: oneOf(
        tone.softLightIntensity,
        Object.keys(LIGHT_INTENSITIES) as LightIntensityKey[],
        base.tone.softLightIntensity,
      ),
    },
    theme: {
      paletteId: typeof theme.paletteId === "string" ? theme.paletteId : null,
      variables: Object.fromEntries(
        THEME_VARIABLES.map((name) => [
          name,
          hex(themeVariables[name], base.theme.variables[name]),
        ]),
      ),
    },
    bgm: {
      enabled: bool(bgm.enabled, base.bgm.enabled),
      volume: number(bgm.volume, base.bgm.volume, 0, 1),
      loop: bool(bgm.loop, base.bgm.loop),
      track:
        typeof track?.path === "string"
          ? {
              name: typeof track.name === "string" ? track.name : track.path,
              path: track.path,
            }
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
        return [
          id,
          {
            transitionSound: oneOf(
              scene.transitionSound,
              TRANSITION_SOUNDS,
              DEFAULT_SCENE_SETTINGS.transitionSound,
            ),
            revealSound: oneOf(
              scene.revealSound,
              REVEAL_SOUNDS,
              DEFAULT_SCENE_SETTINGS.revealSound,
            ),
            motionPreset: oneOf(
              scene.motionPreset,
              MOTION_PRESETS,
              DEFAULT_SCENE_SETTINGS.motionPreset,
            ),
            hidden: bool(scene.hidden, DEFAULT_SCENE_SETTINGS.hidden),
          },
        ];
      }),
    ),
  };
}

export type PreviewSettingsPatch = {
  [K in keyof PreviewSettings]?: Partial<PreviewSettings[K]>;
};

/**
 * Section-level merge, then normalize. The UI sends one section at a time, so a
 * concurrent edit in another card is never clobbered by a stale full payload.
 */
export function mergePreviewSettings(
  current: PreviewSettings,
  patch: PreviewSettingsPatch,
): PreviewSettings {
  const themePatch = patch.theme as Partial<ThemeSettings> | undefined;
  const customColors = themePatch?.variables !== undefined
    || patch.tone?.backgroundColor !== undefined
    || patch.tone?.mainLight !== undefined
    || patch.tone?.softLight !== undefined
    || patch.subtitles?.color !== undefined
    || patch.subtitles?.activeColor !== undefined;
  return normalizePreviewSettings({
    tone: { ...current.tone, ...patch.tone },
    theme: {
      paletteId: !customColors
        ? themePatch?.paletteId ?? current.theme.paletteId
        : null,
      variables: {
        ...current.theme.variables,
        ...themePatch?.variables,
      },
    },
    bgm: { ...current.bgm, ...patch.bgm },
    subtitles: { ...current.subtitles, ...patch.subtitles },
    scenes: { ...current.scenes, ...patch.scenes },
  });
}

export function sceneSettings(
  settings: PreviewSettings,
  sceneId: string,
): SceneSettings {
  return settings.scenes[sceneId] ?? DEFAULT_SCENE_SETTINGS;
}

export function hexToRgba(value: string, alpha: number): string {
  const match = HEX.test(value) ? value.slice(1) : "000000";
  const int = Number.parseInt(match, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * What counts as a caption. The explicit hooks come first; the substring
 * matches catch the real convention — compositions name their caption elements
 * `#caption-container`, `.caption-box`, `.caption-text` and never opt in to
 * anything.
 */
const CAPTION_SELECTOR = [
  ".caption",
  ".subtitle",
  "[data-hf-caption]",
  "[data-subtitle]",
  '[class*="caption" i]',
  '[class*="subtitle" i]',
  '[id*="caption" i]',
  '[id*="subtitle" i]',
].join(",\n");

const FX_KEYFRAMES = `
@keyframes hf-fx-scan { to { transform: translate3d(0, 220px, 0); } }
@keyframes hf-fx-drift { to { transform: translate3d(-140px, -180px, 0); } }
@keyframes hf-fx-rings { to { transform: scale(1.9); opacity: 0; } }
@keyframes hf-fx-spin { to { transform: rotate(360deg); } }
`;

function fxLayer(tone: ToneSettings): string {
  const main = hexToRgba(tone.mainLight, 0.5);
  const soft = hexToRgba(tone.softLight, 0.35);

  switch (tone.backgroundFx) {
    case "scan":
      // The band travels by `transform`, not by `background-position`: moving
      // the background repainted the whole frame on the main thread sixty times
      // a second, where a transform stays on the compositor. 220px is a whole
      // number of 5px bands, so the loop restart is invisible, and the layer is
      // grown by that much at the top so nothing uncovers as it slides.
      return `inset: -220px 0 0 0;
  background-image: repeating-linear-gradient(180deg, ${main} 0 1px, transparent 1px 5px);
  opacity: 0.16;
  animation: hf-fx-scan 3s linear infinite;`;
    case "particles":
      return `inset: -20%;
  background-image:
    radial-gradient(2px 2px at 12% 22%, ${main} 50%, transparent 51%),
    radial-gradient(2px 2px at 68% 14%, ${soft} 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 34% 76%, ${main} 50%, transparent 51%),
    radial-gradient(2.5px 2.5px at 84% 62%, ${soft} 50%, transparent 51%);
  background-size: 240px 240px, 320px 320px, 180px 180px, 400px 400px;
  opacity: 0.5;
  animation: hf-fx-drift 14s linear infinite;`;
    case "rings":
      return `background-image: repeating-radial-gradient(circle at 50% 50%, transparent 0 78px, ${main} 78px 80px);
  opacity: 0.2;
  transform-origin: 50% 50%;
  animation: hf-fx-rings 6s ease-out infinite;`;
    case "lorenz":
      return `background-image:
    conic-gradient(from 0deg at 36% 46%, transparent 0 40%, ${main} 50%, transparent 60% 100%),
    conic-gradient(from 180deg at 64% 54%, transparent 0 40%, ${soft} 50%, transparent 60% 100%);
  filter: blur(28px);
  opacity: 0.35;
  animation: hf-fx-spin 24s linear infinite;`;
    default:
      return "display: none;";
  }
}

/**
 * The stylesheet injected into the preview root *and* every sub-composition
 * document, so a colour set here reaches scenes rendered in their own frame.
 */
export function buildPreviewCss(settings: PreviewSettings): string {
  const { tone, theme, subtitles } = settings;
  const mainPosition = LIGHT_POSITIONS[tone.mainLightPosition];
  const softPosition = LIGHT_POSITIONS[tone.softLightPosition];
  const mainAlpha = LIGHT_INTENSITIES[tone.mainLightIntensity].alpha;
  const softAlpha = LIGHT_INTENSITIES[tone.softLightIntensity].alpha;
  const cream = tone.colorMode === "cream";
  const background = tone.backgroundColor;

  const variables = Object.entries(theme.variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

  const hidden = Object.entries(settings.scenes)
    .filter(([, value]) => value.hidden)
    .map(([id]) => `[data-composition-id="${id}"]`)
    .join(",\n");

  return `:root {
${variables}
  --bg-dark: ${background};
  --tone-bg: ${background};
  --tone-main-light: ${tone.mainLight};
  --tone-main-rgba: ${hexToRgba(tone.mainLight, mainAlpha)};
  --tone-main-x: ${mainPosition.x};
  --tone-main-y: ${mainPosition.y};
  --tone-soft-light: ${tone.softLight};
  --tone-soft-rgba: ${hexToRgba(tone.softLight, softAlpha)};
  --tone-soft-x: ${softPosition.x};
  --tone-soft-y: ${softPosition.y};
  --subtitle-color: ${subtitles.color};
  --subtitle-active-color: ${subtitles.activeColor};
  --subtitle-font-size: ${subtitles.fontSize}px;
  --subtitle-bottom: ${subtitles.bottom}px;
}

${
  subtitles.override
    ? `/* Take over caption styling. Compositions hard-code their caption colour
   and size in their own stylesheet, so nothing short of !important reaches
   them — which is exactly what the override switch is asking for. */
${CAPTION_SELECTOR} {
  color: var(--subtitle-color) !important;
  font-size: var(--subtitle-font-size) !important;
  bottom: var(--subtitle-bottom) !important;
}

${CAPTION_SELECTOR
  .split(",\n")
  .map((selector) => `${selector} .active`)
  .join(",\n")} {
  color: var(--subtitle-active-color) !important;
}
`
    : `/* Variables only: a composition that reads them restyles itself, one that
   hard-codes its captions keeps its own design until "Take over caption
   styling" is switched on. */
.caption,
.subtitle,
[data-hf-caption],
[data-subtitle] {
  color: var(--subtitle-color);
  font-size: var(--subtitle-font-size);
  bottom: var(--subtitle-bottom);
}
`
}${
  subtitles.enabled
    ? ""
    : `
${CAPTION_SELECTOR} {
  display: none !important;
}
`
}${
    hidden
      ? `
${hidden} {
  display: none !important;
}
`
      : ""
  }
${
  hasOverlay(settings)
    ? `#hf-preview-tone {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  overflow: hidden;
}

#hf-preview-tone .hf-tone-light {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(60% 55% at var(--tone-main-x) var(--tone-main-y), var(--tone-main-rgba), transparent 70%),
    radial-gradient(55% 50% at var(--tone-soft-x) var(--tone-soft-y), var(--tone-soft-rgba), transparent 70%);
  /* screen lifts a dark frame, multiply deepens a light one. Picking the wrong
     one for the composition blows the image out, which is why the mode is the
     author's explicit choice rather than a guess. */
  mix-blend-mode: ${cream ? "multiply" : "screen"};
}

#hf-preview-tone .hf-tone-fx {
  position: absolute;
  inset: 0;
  will-change: transform;
  ${fxLayer(tone)}
}

/* The overlay is decorative and loops forever, so left alone it kept a core
   and the GPU busy on a paused preview. The class is set from the transport —
   see buildFxPauseScript(). */
#hf-preview-tone.hf-fx-paused .hf-tone-fx {
  animation-play-state: paused;
}
${FX_KEYFRAMES}`
    : ""
}`;
}

/** Whether anything is asking for the overlay element at all. */
function hasOverlay(settings: PreviewSettings): boolean {
  return settings.tone.enabled || settings.tone.backgroundFx !== "none";
}

/**
 * Overlay markup for the preview root only — sub-compositions inherit the CSS.
 *
 * Emitted only when a layer is actually switched on. An untouched project must
 * get a byte-for-byte unmodified body, so the preview matches what renders.
 */
export function buildToneOverlayHtml(settings: PreviewSettings): string {
  if (!hasOverlay(settings)) return "";

  const light = settings.tone.enabled ? '<div class="hf-tone-light"></div>' : "";
  const fx =
    settings.tone.backgroundFx !== "none"
      ? '<div class="hf-tone-fx"></div>'
      : "";
  // Paused until the transport says otherwise: the preview opens stopped.
  return `<div id="hf-preview-tone" class="hf-fx-paused" aria-hidden="true">${light}${fx}</div>`;
}

/**
 * Runs the background FX off the transport instead of off the wall clock.
 *
 * The player drives this document over `postMessage` — `{source: "hf-parent",
 * type: "control", action: "play" | "pause" | …}` — which is the only signal in
 * here for whether the composition is running. Without it a decorative loop
 * animated forever behind a paused preview.
 */
export function buildFxPauseScript(settings: PreviewSettings): string {
  if (settings.tone.backgroundFx === "none") return "";

  return `<script>(function(){
  var overlay = document.getElementById("hf-preview-tone");
  if (!overlay) return;
  addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "hf-parent" || data.type !== "control") return;
    if (data.action === "play") overlay.classList.remove("hf-fx-paused");
    else if (data.action === "pause") overlay.classList.add("hf-fx-paused");
  });
})();</script>`;
}

/**
 * A runtime-managed `<audio class="clip">`: the hyperframe runtime picks up
 * every `video, audio` in the document and drives it off the transport, so the
 * track scrubs with the timeline instead of playing on its own clock.
 */
export function buildBgmHtml(
  settings: PreviewSettings,
  fileBaseUrl: string,
): string {
  const { bgm } = settings;
  if (!bgm.enabled || !bgm.track) return "";

  const src = `${fileBaseUrl}${bgm.track.path}`;
  return `<audio id="hf-preview-bgm" class="clip" preload="none" src="${src}" data-start="0" data-volume="${bgm.volume}"${
    bgm.loop ? " loop" : ""
  }></audio>`;
}
