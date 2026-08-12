import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPreviewCss, injectPreviewSettingsDocument } from "@vidcom/adapter";
import { DEFAULT_PREVIEW_SETTINGS as CORE_DEFAULT_PREVIEW_SETTINGS } from "@vidcom/core";
import {
  BACKGROUND_FX,
  DEFAULT_PREVIEW_SETTINGS,
  mergePreviewSettings,
  type PreviewSettings,
} from "@/lib/studio/preview-settings";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_FIXTURE = path.join(REPOSITORY_ROOT, "fixtures/preview");
const PROJECTS_ROOT = path.join(REPOSITORY_ROOT, "projects");
const PROJECT_SLUG = `__golden-preview-${process.pid}-${randomUUID()}`;
const PROJECT_ROOT = path.join(PROJECTS_ROOT, PROJECT_SLUG);
const BASE_HTML = readFileSync(path.join(SOURCE_FIXTURE, "index.html"), "utf8");

type ToneCase = "off" | "dark" | "cream";

/** Build one complete normalized settings object for a matrix coordinate. */
function settingsFor(
  tone: ToneCase,
  backgroundFx: keyof typeof BACKGROUND_FX,
  subtitleOverride: boolean,
  sceneHidden: boolean,
): PreviewSettings {
  return mergePreviewSettings(DEFAULT_PREVIEW_SETTINGS, {
    tone: {
      enabled: tone !== "off",
      colorMode: tone === "cream" ? "cream" : "dark",
      backgroundFx,
    },
    subtitles: { override: subtitleOverride },
    scenes: {
      "scene-a": {
        transitionSound: "minimal",
        revealSound: "ping",
        hidden: sceneHidden,
      },
    },
  });
}

beforeAll(() => {
  mkdirSync(PROJECTS_ROOT, { recursive: true });
  cpSync(SOURCE_FIXTURE, PROJECT_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

describe("preview settings matrix", () => {
  it("keeps the editor and render pipeline on the same default palette", () => {
    expect(DEFAULT_PREVIEW_SETTINGS).toEqual(CORE_DEFAULT_PREVIEW_SETTINGS);
  });

  it("locks CSS and root-document injection for all 60 combinations", async () => {
    const matrix: Record<string, { css: string; html: string }> = {};

    for (const tone of ["off", "dark", "cream"] as const) {
      for (const backgroundFx of Object.keys(BACKGROUND_FX) as Array<
        keyof typeof BACKGROUND_FX
      >) {
        for (const subtitleOverride of [false, true]) {
          for (const sceneHidden of [false, true]) {
            const settings = settingsFor(
              tone,
              backgroundFx,
              subtitleOverride,
              sceneHidden,
            );
            writeFileSync(
              path.join(PROJECT_ROOT, "preview-settings.json"),
              `${JSON.stringify(settings, null, 2)}\n`,
              "utf8",
            );

            const key = [
              `tone=${tone}`,
              `fx=${backgroundFx}`,
              `override=${subtitleOverride}`,
              `hidden=${sceneHidden}`,
            ].join(";");
            matrix[key] = {
              css: buildPreviewCss(settings),
              html: injectPreviewSettingsDocument(BASE_HTML, settings, {
                root: true,
                fileBaseUrl: `/api/hf/${PROJECT_SLUG}/files/`,
              }).replaceAll(PROJECT_SLUG, "preview-fixture"),
            };
          }
        }
      }
    }

    expect(Object.keys(matrix)).toHaveLength(60);
    await expect(`${JSON.stringify(matrix, null, 2)}\n`).toMatchFileSnapshot(
      "../../fixtures/preview/preview-matrix-expected.json",
    );
  });
});
