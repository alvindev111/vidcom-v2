import "server-only";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBgmHtml,
  buildFxPauseScript,
  buildPreviewCss,
  buildToneOverlayHtml,
  mergePreviewSettings,
  normalizePreviewSettings,
  type PreviewSettings,
  type PreviewSettingsPatch,
} from "@/lib/studio/preview-settings";
import { projectPaths } from "./projects.server";

const FILE = "preview-settings.json";

/** Uploaded background music, kept inside the project so a render can find it. */
const BGM_DIR = "preview-assets/bgm";

export function readPreviewSettings(slug: string): PreviewSettings {
  const paths = projectPaths(slug);
  if (!paths) return normalizePreviewSettings(null);

  const file = join(paths.dir, FILE);
  if (!existsSync(file)) return normalizePreviewSettings(null);

  try {
    return normalizePreviewSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // A hand-edited file with a syntax error should not break the studio.
    return normalizePreviewSettings(null);
  }
}

export function writePreviewSettings(
  slug: string,
  patch: PreviewSettingsPatch,
): PreviewSettings | null {
  const paths = projectPaths(slug);
  if (!paths) return null;

  const next = mergePreviewSettings(readPreviewSettings(slug), patch);
  writeFileSync(
    join(paths.dir, FILE),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return next;
}

/** Store an uploaded track and point the BGM settings at it. */
export function savePreviewBgm(
  slug: string,
  name: string,
  bytes: Uint8Array,
): PreviewSettings | null {
  const paths = projectPaths(slug);
  if (!paths) return null;

  const safeName = name.replace(/[^\w.-]+/g, "-").replace(/^-+/, "");
  if (!safeName) return null;

  mkdirSync(join(paths.dir, BGM_DIR), { recursive: true });
  writeFileSync(join(paths.dir, BGM_DIR, safeName), bytes);

  return writePreviewSettings(slug, {
    bgm: { enabled: true, track: { name: safeName, path: `${BGM_DIR}/${safeName}` } },
  });
}

/**
 * Apply the settings to a preview document.
 *
 * The stylesheet goes into every composition document — the runtime loads a
 * `data-composition-src` scene in its own frame, so variables set only on the
 * root would never reach it. The tone overlay and the BGM element belong to the
 * root alone, or each scene would stack its own copy.
 */
export function injectPreviewSettings(
  slug: string,
  html: string,
  { root }: { root: boolean },
): string {
  const settings = readPreviewSettings(slug);
  const style = `<style id="hf-preview-settings">\n${buildPreviewCss(settings)}\n</style>`;

  let output = html.includes("</head>")
    ? html.replace("</head>", `${style}\n</head>`)
    : `${style}\n${html}`;

  if (root) {
    const body =
      buildToneOverlayHtml(settings) +
      buildBgmHtml(settings, `/api/hf/${slug}/files/`) +
      buildFxPauseScript(settings);
    output = output.includes("</body>")
      ? output.replace("</body>", `${body}\n</body>`)
      : output + body;
  }

  return output;
}
