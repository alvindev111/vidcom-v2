import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_PREVIEW_SETTINGS,
  mergePreviewSettings,
  normalizePreviewSettings,
  type PreviewSettings,
  type ProjectRef,
} from "@vidcom/core";
import type { PreviewSettingsPatchDto } from "@vidcom/contracts";

import { injectPreviewSettingsDocument } from "./document";
import type { Narration } from "./types";

const PREVIEW_FILE = "preview-settings.json";
const BGM_DIRECTORY = "preview-assets/bgm";
const NARRATION_DIRECTORY = "narration";
const DEFAULT_VOICE = "af_heart";

export function readLegacyPreviewSettings(ref: ProjectRef): PreviewSettings {
  const filename = join(ref.root, PREVIEW_FILE);
  if (!existsSync(filename)) return DEFAULT_PREVIEW_SETTINGS;
  try { return normalizePreviewSettings(JSON.parse(readFileSync(filename, "utf8"))); }
  catch { return DEFAULT_PREVIEW_SETTINGS; }
}

export function writeLegacyPreviewSettings(ref: ProjectRef, patch: PreviewSettingsPatchDto): PreviewSettings {
  const settings = mergePreviewSettings(readLegacyPreviewSettings(ref), patch);
  writeFileSync(join(ref.root, PREVIEW_FILE), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

export function saveLegacyPreviewBgm(ref: ProjectRef, name: string, bytes: Uint8Array): PreviewSettings | null {
  const safeName = name.replace(/[^\w.-]+/g, "-").replace(/^-+/, "");
  if (!safeName) return null;
  mkdirSync(join(ref.root, BGM_DIRECTORY), { recursive: true });
  writeFileSync(join(ref.root, BGM_DIRECTORY, safeName), bytes);
  return writeLegacyPreviewSettings(ref, {
    bgm: { enabled: true, track: { name: safeName, path: `${BGM_DIRECTORY}/${safeName}` } },
  });
}

export function injectLegacyPreviewSettings(ref: ProjectRef, html: string, root: boolean): string {
  return injectPreviewSettingsDocument(html, readLegacyPreviewSettings(ref), {
    root,
    fileBaseUrl: `/api/hf/${ref.slug}/files/`,
  });
}

export function readLegacyNarration(ref: ProjectRef, sceneId: string): Narration | null {
  const filename = join(ref.root, NARRATION_DIRECTORY, `${sceneId}.json`);
  if (!existsSync(filename)) return null;
  try {
    const narration = JSON.parse(readFileSync(filename, "utf8")) as Narration;
    return { ...narration, status: existsSync(join(ref.root, narration.audioPath)) ? "generated" : "mock" };
  } catch { return null; }
}

export function regenerateLegacyNarration(ref: ProjectRef, sceneId: string, text: string): Narration {
  const previous = readLegacyNarration(ref, sceneId);
  const audioPath = `${NARRATION_DIRECTORY}/${sceneId}.wav`;
  const narration: Narration = {
    sceneId,
    text,
    voice: DEFAULT_VOICE,
    status: "mock",
    audioPath,
    command: `hyperframes tts --text "${text.replace(/"/g, '\\"')}" --voice ${DEFAULT_VOICE} -o ${audioPath}`,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(join(ref.root, NARRATION_DIRECTORY), { recursive: true });
  writeFileSync(join(ref.root, NARRATION_DIRECTORY, `${sceneId}.json`), `${JSON.stringify(narration, null, 2)}\n`, "utf8");
  return narration;
}
