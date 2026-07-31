import "server-only";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Narration } from "@/lib/studio/types";
import { projectPaths } from "./projects.server";

const NARRATION_DIR = "narration";
const DEFAULT_VOICE = "af_heart";

/**
 * Narration is stored as a per-scene sidecar next to the composition.
 *
 * `hyperframes tts` (Kokoro-82M) is the real generator, but it needs
 * `pip install kokoro-onnx soundfile` — absent here, so a regenerate records the
 * job with `status: "mock"` and the exact command that would render the wav.
 * Nothing in the UI claims audio exists until a wav is actually on disk.
 */
function sidecarPath(dir: string, sceneId: string): string {
  return join(dir, NARRATION_DIR, `${sceneId}.json`);
}

function audioPath(sceneId: string): string {
  return `${NARRATION_DIR}/${sceneId}.wav`;
}

function ttsCommand(sceneId: string, text: string): string {
  const escaped = text.replace(/"/g, '\\"');
  return `hyperframes tts --text "${escaped}" --voice ${DEFAULT_VOICE} -o ${audioPath(sceneId)}`;
}

export function readNarration(slug: string, sceneId: string): Narration | null {
  const paths = projectPaths(slug);
  if (!paths) return null;

  const path = sidecarPath(paths.dir, sceneId);
  if (!existsSync(path)) return null;

  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Narration;
    return {
      ...stored,
      // A wav appearing on disk (real `hyperframes tts` run) wins over the record.
      status: existsSync(join(paths.dir, stored.audioPath))
        ? "generated"
        : "mock",
    };
  } catch {
    return null;
  }
}

/** Re-run TTS for a scene. Called whenever its script changes. */
export function regenerateNarration(
  slug: string,
  sceneId: string,
  text: string,
): Narration | null {
  const paths = projectPaths(slug);
  if (!paths) return null;

  const previous = readNarration(slug, sceneId);
  const narration: Narration = {
    sceneId,
    text,
    voice: DEFAULT_VOICE,
    status: "mock",
    audioPath: audioPath(sceneId),
    command: ttsCommand(sceneId, text),
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(join(paths.dir, NARRATION_DIR), { recursive: true });
  writeFileSync(
    sidecarPath(paths.dir, sceneId),
    `${JSON.stringify(narration, null, 2)}\n`,
    "utf8",
  );

  return narration;
}
