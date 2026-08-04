import { buildSubCompositionHtml } from "@hyperframes/studio-server";

import type { PreviewSettings, ProjectRef } from "@vidcom/core";

import { readNarrationClips, type NarrationClip } from "./narration-clips";
import {
  buildBgmHtml,
  buildFxPauseScript,
  buildNarrationHtml,
  buildPreviewCss,
  buildToneOverlayHtml,
  type RenderablePreviewSettings,
} from "./preview-style";

export interface DocumentOptions {
  root: boolean;
  runtimeUrl?: string;
  fileBaseUrl?: string;
}

/** Inserts the runtime guard before every author-controlled head element. */
export function injectRuntimeAssetGuardDocument(
  html: string,
  guard: { csp: string; bootstrapScript: string },
): string {
  const head = html.match(/<head\b[^>]*>/iu);
  if (!head || head.index === undefined) throw new Error("HyperFrames document has no head for the runtime asset guard");
  const csp = guard.csp.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const injection = `<meta data-vidcom-runtime-guard="csp" http-equiv="Content-Security-Policy" content="${csp}">\n`
    + `<script data-vidcom-runtime-guard="bootstrap">${guard.bootstrapScript}</script>`;
  const insertion = head.index + head[0].length;
  return `${html.slice(0, insertion)}\n${injection}${html.slice(insertion)}`;
}

export function buildHyperframesBaseDocument(
  projectRoot: string,
  entry: string,
  runtimeUrl: string,
  fileBaseUrl: string,
): string | null {
  return buildSubCompositionHtml(projectRoot, entry, runtimeUrl, fileBaseUrl);
}

/** Injects settings into an already-built document; exported for golden compatibility checks. */
export function injectPreviewSettingsDocument(
  html: string,
  settings: RenderablePreviewSettings,
  options: {
    root: boolean;
    fileBaseUrl: string;
    /** Generated narration to schedule; omitted leaves the document silent, as before. */
    narration?: readonly NarrationClip[];
  },
): string {
  const style = `<style id="hf-preview-settings">\n${buildPreviewCss(settings)}\n</style>`;
  let output = html.includes("</head>") ? html.replace("</head>", `${style}\n</head>`) : `${style}\n${html}`;
  if (options.root) {
    const body = buildToneOverlayHtml(settings)
      + buildBgmHtml(settings, options.fileBaseUrl)
      + buildNarrationHtml(options.narration ?? [], options.fileBaseUrl)
      + buildFxPauseScript(settings);
    output = output.includes("</body>") ? output.replace("</body>", `${body}\n</body>`) : output + body;
  }
  return output;
}

/** Sole preview-document builder: HyperFrames bundling followed by settings injection. */
export async function buildCompositionDocument(
  ref: ProjectRef,
  settings: PreviewSettings,
  options: DocumentOptions,
): Promise<string> {
  const runtimeUrl = options.runtimeUrl ?? "/api/hf/runtime";
  const fileBaseUrl = options.fileBaseUrl ?? `/api/hf/${ref.slug}/files/`;
  const html = buildHyperframesBaseDocument(ref.root, ref.entry, runtimeUrl, fileBaseUrl);
  if (html === null) throw new Error("HyperFrames could not build the project preview document");
  return injectPreviewSettingsDocument(html, settings, {
    root: options.root,
    fileBaseUrl,
    // Only the root document owns the timeline; a sub-composition rendered on
    // its own would otherwise play every scene's narration at once.
    narration: options.root ? readNarrationClips(ref, html) : [],
  });
}
