import { buildSubCompositionHtml } from "@hyperframes/studio-server";

import type { CompositionDocumentOptions, PreviewSettings, ProjectRef } from "@vidcom/core";
import { PREVIEW_DOCUMENT_CSP } from "@vidcom/contracts";

import { readNarrationClips, type NarrationClip } from "./narration-clips";
import {
  buildBgmHtml,
  buildCaptionRuntimeScript,
  buildFxPauseScript,
  buildNarrationHtml,
  buildPreviewCss,
  buildToneOverlayHtml,
  type RenderablePreviewSettings,
} from "./preview-style";

export type DocumentOptions = CompositionDocumentOptions;

/** Installed before any authored/runtime script so preflight observes parse-time failures too. */
export function buildHealthCollectorScript(): string {
  return `(()=>{const health={scriptErrors:0,rejections:0,resourceErrors:0};Object.defineProperty(window,"__vidcomHealth",{configurable:false,enumerable:false,value:health,writable:false});window.addEventListener("error",event=>{const target=event.target;if(target&&target!==window)health.resourceErrors+=1;else health.scriptErrors+=1},true);window.addEventListener("unhandledrejection",()=>{health.rejections+=1})})();`;
}

function injectPreviewHealthCollectorDocument(
  html: string,
  identity: { projectRevision: number; changeSeq: number },
): string {
  const head = html.match(/<head\b[^>]*>/iu);
  if (!head || head.index === undefined) throw new Error("HyperFrames document has no head for the preview health collector");
  const csp = PREVIEW_DOCUMENT_CSP.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const injection = `<meta data-vidcom-preview-security="csp" http-equiv="Content-Security-Policy" content="${csp}">\n`
    + `<script data-vidcom-health="collector" data-project-revision="${identity.projectRevision}" data-change-seq="${identity.changeSeq}">${buildHealthCollectorScript()}</script>`;
  const insertion = head.index + head[0].length;
  return `${html.slice(0, insertion)}\n${injection}${html.slice(insertion)}`;
}

/** Replaces HyperFrames' compatibility CDN tag with the daemon's pinned, offline copy. */
function localizePreviewRuntimeDependencies(html: string, runtimeUrl: string): string {
  const gsapUrl = runtimeUrl.replace(/\/runtime$/u, "/vendor/gsap.js");
  return html.replace(
    /https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@3(?:\.[^/"']*)?\/dist\/gsap\.min\.js/giu,
    gsapUrl,
  );
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

/**
 * Places runtime-managed media below the first composition host in the body.
 * HyperFrames intentionally ignores timed media outside a composition subtree,
 * so appending preview audio beside the root makes it visible but unplayable.
 */
function injectIntoRootCompositionDocument(html: string, markup: string): string {
  if (!markup) return html;
  const body = /<body\b[^>]*>/iu.exec(html);
  const searchStart = body?.index === undefined ? 0 : body.index + body[0].length;
  const root = /<[a-z][a-z0-9:-]*\b(?=[^>]*\bdata-composition-id\s*=)[^>]*>/iu.exec(html.slice(searchStart));
  if (!root) {
    throw new Error("HyperFrames document has no root composition for preview media");
  }
  const insertion = searchStart + root.index + root[0].length;
  return `${html.slice(0, insertion)}${markup}${html.slice(insertion)}`;
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
    const composition = buildToneOverlayHtml(settings)
      + buildBgmHtml(settings, options.fileBaseUrl)
      + buildNarrationHtml(options.narration ?? [], options.fileBaseUrl);
    output = injectIntoRootCompositionDocument(output, composition);
    const runtime = buildCaptionRuntimeScript() + buildFxPauseScript(settings);
    output = output.includes("</body>") ? output.replace("</body>", `${runtime}\n</body>`) : output + runtime;
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
  const base = buildHyperframesBaseDocument(ref.root, ref.entry, runtimeUrl, fileBaseUrl);
  if (base === null) throw new Error("HyperFrames could not build the project preview document");
  const html = options.mode === "preview"
    ? injectPreviewHealthCollectorDocument(localizePreviewRuntimeDependencies(base, runtimeUrl), options)
    : base;
  return injectPreviewSettingsDocument(html, settings, {
    root: options.root,
    fileBaseUrl,
    // Only the root document owns the timeline; a sub-composition rendered on
    // its own would otherwise play every scene's narration at once.
    narration: options.root ? readNarrationClips(ref, html) : [],
  });
}
