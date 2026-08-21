import {
  buildHealthCollectorScript,
  injectPreviewSettingsDocument,
} from "@vidcom/adapter";
import { DEFAULT_PREVIEW_SETTINGS } from "@vidcom/core";

export const CAPTION_PARITY_POINTS = [
  { action: "play", rootSeconds: 6.3, active: "một" },
  { action: "seek", rootSeconds: 6.65, active: "hai" },
  { action: "rate-2x", rootSeconds: 6.95, active: "ba" },
] as const;

const BASE = `<html><head><style>
.caption .w { color: #111111; }
</style></head><body>
<main data-composition-id="root" data-duration="12" data-fps="30000/1001">
  <section data-composition-id="scene-2" data-composition-src="scene-2.html" data-start="6" data-duration="6">
    <div class="captions" data-caption-timing="engine">
      <p class="caption clip" data-start="0.2" data-duration="1">
        <span class="w" data-start="0.2" data-end="0.5">một</span>
        <span class="w" data-start="0.5" data-end="0.8">hai</span>
        <span class="w" data-start="0.8" data-end="1.2">ba</span>
      </p>
    </div>
  </section>
</main>
</body></html>`;

/** Shared deterministic document for P6 browser probes and P11 preview/render frame parity. */
export function captionRuntimeBrowserDocument(mode: "preview" | "render"): string {
  const withMode = BASE.replace("<head>", `<head><meta name="vidcom-parity-mode" content="${mode}">`)
    .replace("<body>", `<body data-caption-parity-mode="${mode}">`);
  const withPreviewHealth = mode === "preview"
    ? withMode.replace("<head>", `<head><script data-vidcom-health="collector">${buildHealthCollectorScript()}</script>`)
    : withMode;
  return injectPreviewSettingsDocument(withPreviewHealth, {
    ...DEFAULT_PREVIEW_SETTINGS,
    subtitles: {
      ...DEFAULT_PREVIEW_SETTINGS.subtitles,
      override: true,
      color: "#111111",
      activeColor: "#12AB34",
    },
  }, { root: true, fileBaseUrl: "/files/" });
}
