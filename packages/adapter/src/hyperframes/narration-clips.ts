import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildNarrationClips, readCues, type ProjectRef } from "@vidcom/core";

import { readCompositionHosts } from "./dom";

const NARRATION_DIRECTORY = "narration";

/** One narration track placed on the root timeline at its scene's start. */
export interface NarrationClip {
  sceneId: string;
  cueId?: string;
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
    const modern = typeof sidecar === "object" && sidecar !== null
      && Array.isArray((sidecar as { cues?: unknown }).cues);
    const legacy = sidecar as { status?: unknown; audioPath?: unknown };
    const legacyStatus: "mock" | "generated" | undefined = legacy.status === "mock" || legacy.status === "generated"
      ? legacy.status : undefined;
    const cues = readCues(sidecar).map((cue) => modern ? cue : {
      ...cue,
      ...(legacyStatus ? { status: legacyStatus } : {}),
      ...(typeof legacy.audioPath === "string" ? { audioPath: legacy.audioPath } : {}),
    }).filter((cue) => {
      const legacyPath = `${NARRATION_DIRECTORY}/${host.id}.wav`;
      const cuePath = `${NARRATION_DIRECTORY}/${host.id}/${cue.cueId}.wav`;
      return cue.status === "generated"
        && (cue.audioPath === legacyPath || cue.audioPath === cuePath)
        && existsSync(join(ref.root, cue.audioPath));
    });
    clips.push(...buildNarrationClips({
      sceneId: host.id,
      start: host.start,
      duration: host.duration,
      trackIndex: host.trackIndex,
    }, cues).flatMap((clip) => clip.path ? [{
      sceneId: clip.sceneId,
      ...(modern ? { cueId: clip.cueId } : {}),
      path: clip.path,
      startSeconds: clip.startSeconds,
      durationSeconds: clip.durationSeconds,
    }] : []));
  }
  return clips;
}

function readSidecar(ref: ProjectRef, sceneId: string): unknown | null {
  const filename = join(ref.root, NARRATION_DIRECTORY, `${sceneId}.json`);
  if (!existsSync(filename)) return null;
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
}
