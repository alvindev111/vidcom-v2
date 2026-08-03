import type { PreviewSettings } from "@vidcom/core";

export type RenderablePreviewSettings = Omit<PreviewSettings, "theme"> & {
  theme: { variables: Record<string, string> };
};

const LIGHT_POSITIONS = {
  "top-left": { x: "18%", y: "20%" }, "top-center": { x: "50%", y: "18%" },
  "top-right": { x: "82%", y: "20%" }, "center-left": { x: "18%", y: "50%" },
  center: { x: "50%", y: "50%" }, "center-right": { x: "82%", y: "50%" },
  "bottom-left": { x: "18%", y: "78%" }, "bottom-center": { x: "50%", y: "80%" },
  "bottom-right": { x: "82%", y: "78%" },
} as const;
const LIGHT_INTENSITIES = { low: 0.14, medium: 0.22, high: 0.3, max: 0.4 } as const;
const CAPTION_SELECTOR = [
  ".caption", ".subtitle", "[data-hf-caption]", "[data-subtitle]",
  '[class*="caption" i]', '[class*="subtitle" i]', '[id*="caption" i]', '[id*="subtitle" i]',
].join(",\n");
const FX_KEYFRAMES = `
@keyframes hf-fx-scan { to { transform: translate3d(0, 220px, 0); } }
@keyframes hf-fx-drift { to { transform: translate3d(-140px, -180px, 0); } }
@keyframes hf-fx-rings { to { transform: scale(1.9); opacity: 0; } }
@keyframes hf-fx-spin { to { transform: rotate(360deg); } }
`;

function hexToRgba(value: string, alpha: number): string {
  const match = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : "000000";
  const integer = Number.parseInt(match, 16);
  return `rgba(${(integer >> 16) & 255}, ${(integer >> 8) & 255}, ${integer & 255}, ${alpha})`;
}

function fxLayer(settings: RenderablePreviewSettings["tone"]): string {
  const main = hexToRgba(settings.mainLight, 0.5);
  const soft = hexToRgba(settings.softLight, 0.35);
  switch (settings.backgroundFx) {
    case "scan": return `inset: -220px 0 0 0;
  background-image: repeating-linear-gradient(180deg, ${main} 0 1px, transparent 1px 5px);
  opacity: 0.16;
  animation: hf-fx-scan 3s linear infinite;`;
    case "particles": return `inset: -20%;
  background-image:
    radial-gradient(2px 2px at 12% 22%, ${main} 50%, transparent 51%),
    radial-gradient(2px 2px at 68% 14%, ${soft} 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 34% 76%, ${main} 50%, transparent 51%),
    radial-gradient(2.5px 2.5px at 84% 62%, ${soft} 50%, transparent 51%);
  background-size: 240px 240px, 320px 320px, 180px 180px, 400px 400px;
  opacity: 0.5;
  animation: hf-fx-drift 14s linear infinite;`;
    case "rings": return `background-image: repeating-radial-gradient(circle at 50% 50%, transparent 0 78px, ${main} 78px 80px);
  opacity: 0.2;
  transform-origin: 50% 50%;
  animation: hf-fx-rings 6s ease-out infinite;`;
    case "lorenz": return `background-image:
    conic-gradient(from 0deg at 36% 46%, transparent 0 40%, ${main} 50%, transparent 60% 100%),
    conic-gradient(from 180deg at 64% 54%, transparent 0 40%, ${soft} 50%, transparent 60% 100%);
  filter: blur(28px);
  opacity: 0.35;
  animation: hf-fx-spin 24s linear infinite;`;
    default: return "display: none;";
  }
}

function hasOverlay(settings: RenderablePreviewSettings): boolean {
  return settings.tone.enabled || settings.tone.backgroundFx !== "none";
}

function cssString(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return /[a-zA-Z0-9_-]/.test(character) ? character : `\\${code.toString(16)} `;
  }).join("");
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function encodedProjectPath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function buildPreviewCss(settings: RenderablePreviewSettings): string {
  const { tone, theme, subtitles } = settings;
  const mainPosition = LIGHT_POSITIONS[tone.mainLightPosition];
  const softPosition = LIGHT_POSITIONS[tone.softLightPosition];
  const mainAlpha = LIGHT_INTENSITIES[tone.mainLightIntensity];
  const softAlpha = LIGHT_INTENSITIES[tone.softLightIntensity];
  const cream = tone.colorMode === "cream";
  const background = cream ? "#fff3df" : tone.backgroundColor;
  const variables = Object.entries(theme.variables).map(([name, value]) => `  ${name}: ${value};`).join("\n");
  const hidden = Object.entries(settings.scenes)
    .filter(([, value]) => value.hidden)
    .map(([id]) => `[data-composition-id="${cssString(id)}"]`)
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

${subtitles.override ? `/* Take over caption styling. Compositions hard-code their caption colour
   and size in their own stylesheet, so nothing short of !important reaches
   them — which is exactly what the override switch is asking for. */
${CAPTION_SELECTOR} {
  color: var(--subtitle-color) !important;
  font-size: var(--subtitle-font-size) !important;
  bottom: var(--subtitle-bottom) !important;
}

${CAPTION_SELECTOR.split(",\n").map((selector) => `${selector} .active`).join(",\n")} {
  color: var(--subtitle-active-color) !important;
}
` : `/* Variables only: a composition that reads them restyles itself, one that
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
`}${subtitles.enabled ? "" : `
${CAPTION_SELECTOR} {
  display: none !important;
}
`}${hidden ? `
${hidden} {
  display: none !important;
}
` : ""}
${hasOverlay(settings) ? `#hf-preview-tone {
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
${FX_KEYFRAMES}` : ""}`;
}

export function buildToneOverlayHtml(settings: RenderablePreviewSettings): string {
  if (!hasOverlay(settings)) return "";
  const light = settings.tone.enabled ? '<div class="hf-tone-light"></div>' : "";
  const fx = settings.tone.backgroundFx !== "none" ? '<div class="hf-tone-fx"></div>' : "";
  return `<div id="hf-preview-tone" class="hf-fx-paused" aria-hidden="true">${light}${fx}</div>`;
}

export function buildFxPauseScript(settings: RenderablePreviewSettings): string {
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
 * Narration `<audio class="clip">` elements for the root document.
 *
 * The runtime schedules anything carrying `clip` plus `data-start`, which is the
 * same mechanism the BGM bed uses — so preview and render pick narration up
 * through one code path (P3) instead of each learning about audio separately.
 *
 * Emitted only when the sidecar reports generated audio, so a project mid-way
 * through narration plays the scenes that have it and stays silent on the rest
 * rather than failing to build.
 */
export function buildNarrationHtml(
  clips: readonly {
    sceneId: string;
    path: string;
    startSeconds: number;
    durationSeconds: number | null;
  }[],
  fileBaseUrl: string,
): string {
  return clips.map((clip) => {
    const source = htmlAttribute(`${fileBaseUrl}${encodedProjectPath(clip.path)}`);
    // data-duration is the measured length, not the scene's: a narration line
    // shorter than its scene must stop when it stops, and one that overruns is
    // a timing problem the author needs to see rather than have trimmed away.
    const duration = clip.durationSeconds === null ? "" : ` data-duration="${clip.durationSeconds}"`;
    return `<audio class="clip hf-narration" data-narration-scene="${htmlAttribute(clip.sceneId)}"`
      + ` src="${source}" data-start="${clip.startSeconds}"${duration}></audio>`;
  }).join("");
}

export function buildBgmHtml(settings: RenderablePreviewSettings, fileBaseUrl: string): string {
  const { bgm } = settings;
  if (!bgm.enabled || !bgm.track) return "";
  const source = htmlAttribute(`${fileBaseUrl}${encodedProjectPath(bgm.track.path)}`);
  return `<audio id="hf-preview-bgm" class="clip" src="${source}" data-start="0" data-volume="${bgm.volume}"${bgm.loop ? " loop" : ""}></audio>`;
}
