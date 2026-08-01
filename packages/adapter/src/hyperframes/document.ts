import { buildSubCompositionHtml } from "@hyperframes/studio-server";

import type { PreviewSettings, ProjectRef } from "@vidcom/core";

import {
  buildBgmHtml,
  buildFxPauseScript,
  buildPreviewCss,
  buildToneOverlayHtml,
  type RenderablePreviewSettings,
} from "./preview-style";

export interface DocumentOptions {
  root: boolean;
  runtimeUrl?: string;
  fileBaseUrl?: string;
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
  options: { root: boolean; fileBaseUrl: string },
): string {
  const style = `<style id="hf-preview-settings">\n${buildPreviewCss(settings)}\n</style>`;
  let output = html.includes("</head>") ? html.replace("</head>", `${style}\n</head>`) : `${style}\n${html}`;
  if (options.root) {
    const body = buildToneOverlayHtml(settings)
      + buildBgmHtml(settings, options.fileBaseUrl)
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
  return injectPreviewSettingsDocument(html, settings, { root: options.root, fileBaseUrl });
}
