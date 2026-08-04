import type { TtsWordTiming } from "../port/tts-port";
import type { SceneClip } from "../domain/invariants";

export interface NarrationCue {
  cueId: string;
  text: string;
  voice: string;
  offsetSeconds: number;
  durationSeconds: number | null;
  staleSince: string | null;
  status?: "mock" | "generated";
  audioPath?: string;
  command?: string;
  words?: TtsWordTiming[];
  wordTimingSource?: "engine" | "estimated";
}

export interface NarrationClip {
  sceneId: string;
  cueId: string;
  startSeconds: number;
  durationSeconds: number | null;
  path?: string;
}

/** Reads current multi-cue sidecars and maps a legacy one-cue record without mutating it. */
export function readCues(sidecar: unknown): NarrationCue[] {
  if (!isRecord(sidecar)) return [];
  if (Array.isArray(sidecar.cues)) return sidecar.cues.flatMap((cue) => parseCue(cue));
  if (typeof sidecar.sceneId !== "string" || typeof sidecar.text !== "string" || typeof sidecar.voice !== "string") return [];
  return [{
    cueId: sidecar.sceneId,
    text: sidecar.text,
    voice: sidecar.voice,
    offsetSeconds: 0,
    durationSeconds: positiveOrNull(sidecar.durationSeconds),
    staleSince: typeof sidecar.staleSince === "string" ? sidecar.staleSince : null,
    ...(Array.isArray(sidecar.words) ? { words: sidecar.words as TtsWordTiming[] } : {}),
    ...(sidecar.wordTimingSource === "engine" || sidecar.wordTimingSource === "estimated"
      ? { wordTimingSource: sidecar.wordTimingSource }
      : {}),
  }];
}

/** Builds one timeline clip per cue, anchored to the scene start from the document. */
export function buildNarrationClips(scene: SceneClip, cues: readonly NarrationCue[]): NarrationClip[] {
  return cues.map((cue) => ({
    sceneId: scene.sceneId,
    cueId: cue.cueId,
    startSeconds: scene.start + cue.offsetSeconds,
    durationSeconds: cue.durationSeconds,
    ...(cue.audioPath ? { path: cue.audioPath } : {}),
  }));
}

function parseCue(value: unknown): NarrationCue[] {
  if (!isRecord(value)
    || typeof value.cueId !== "string"
    || typeof value.text !== "string"
    || typeof value.voice !== "string"
    || typeof value.offsetSeconds !== "number"
    || !Number.isFinite(value.offsetSeconds)
    || value.offsetSeconds < 0) return [];
  return [{
    cueId: value.cueId,
    text: value.text,
    voice: value.voice,
    offsetSeconds: value.offsetSeconds,
    durationSeconds: positiveOrNull(value.durationSeconds),
    staleSince: typeof value.staleSince === "string" ? value.staleSince : null,
    ...(value.status === "mock" || value.status === "generated" ? { status: value.status } : {}),
    ...(typeof value.audioPath === "string" ? { audioPath: value.audioPath } : {}),
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(Array.isArray(value.words) ? { words: value.words as TtsWordTiming[] } : {}),
    ...(value.wordTimingSource === "engine" || value.wordTimingSource === "estimated"
      ? { wordTimingSource: value.wordTimingSource }
      : {}),
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
