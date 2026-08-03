import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProjectRef } from "@vidcom/core";

import { readCompositionHosts } from "./dom";
import type { Narration } from "./types";

const NARRATION_DIRECTORY = "narration";

/** One narration track placed on the root timeline at its scene's start. */
export interface NarrationClip {
  sceneId: string;
  /** Project-relative path to the WAV, for the file-serving base URL. */
  path: string;
  startSeconds: number;
  durationSeconds: number | null;
}

/**
 * Narration clips for every scene in the built document that has generated audio
 * on disk, in document order.
 *
 * Scene start times come from the built document's `data-*` attributes rather
 * than from the sidecars (P1): the sidecar records what was spoken, the document
 * records when the scene plays, and only one of those moves when an author drags
 * a scene on the timeline.
 *
 * Skips scenes whose sidecar says `mock`, whose WAV is missing, or whose sidecar
 * will not parse — a silent scene is the correct outcome for narration that was
 * never generated, and a broken sidecar must not take the whole preview down.
 *
 * Reads the filesystem: one sidecar and one `existsSync` per scene.
 */
export function readNarrationClips(ref: ProjectRef, html: string): NarrationClip[] {
  const clips: NarrationClip[] = [];
  for (const host of readCompositionHosts(html)) {
    if (!host.id) continue;
    const sidecar = readSidecar(ref, host.id);
    if (!sidecar) continue;
    const audioPath = `${NARRATION_DIRECTORY}/${host.id}.wav`;
    if (sidecar.audioPath !== audioPath || !existsSync(join(ref.root, audioPath))) continue;
    clips.push({
      sceneId: host.id,
      path: audioPath,
      startSeconds: host.start,
      durationSeconds: typeof sidecar.durationSeconds === "number" && sidecar.durationSeconds > 0
        ? sidecar.durationSeconds
        : null,
    });
  }
  return clips;
}

function readSidecar(ref: ProjectRef, sceneId: string): Narration | null {
  const filename = join(ref.root, NARRATION_DIRECTORY, `${sceneId}.json`);
  if (!existsSync(filename)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8")) as Narration;
    return typeof parsed?.audioPath === "string" ? parsed : null;
  } catch {
    return null;
  }
}
