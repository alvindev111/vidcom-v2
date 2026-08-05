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
  provider?: string;
  words?: TtsWordTiming[];
  wordTimingSource?: "engine" | "estimated";
  engine?: Record<string, string | number | boolean>;
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
  const engine = engineMetadata(sidecar.engine);
  const words = wordTimings(sidecar.words);
  return [{
    cueId: sidecar.sceneId,
    text: sidecar.text,
    voice: sidecar.voice,
    offsetSeconds: 0,
    durationSeconds: positiveOrNull(sidecar.durationSeconds),
    staleSince: typeof sidecar.staleSince === "string" ? sidecar.staleSince : null,
    ...(sidecar.status === "mock" || sidecar.status === "generated" ? { status: sidecar.status } : {}),
    ...(typeof sidecar.audioPath === "string" ? { audioPath: sidecar.audioPath } : {}),
    ...(typeof sidecar.command === "string" ? { command: sidecar.command } : {}),
    ...(typeof sidecar.provider === "string" ? { provider: sidecar.provider } : {}),
    ...(words ? { words } : {}),
    ...(sidecar.wordTimingSource === "engine" || sidecar.wordTimingSource === "estimated"
      ? { wordTimingSource: sidecar.wordTimingSource }
      : {}),
    ...(engine ? { engine } : {}),
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
  const engine = engineMetadata(value.engine);
  const words = wordTimings(value.words);
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
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(words ? { words } : {}),
    ...(value.wordTimingSource === "engine" || value.wordTimingSource === "estimated"
      ? { wordTimingSource: value.wordTimingSource }
      : {}),
    ...(engine ? { engine } : {}),
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function engineMetadata(value: unknown): Record<string, string | number | boolean> | null {
  if (!isRecord(value)) return null;
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" && typeof item !== "boolean"
      && (typeof item !== "number" || !Number.isFinite(item))) return null;
    metadata[key] = item;
  }
  return metadata;
}

function wordTimings(value: unknown): TtsWordTiming[] | null {
  if (!Array.isArray(value)) return null;
  const timings: TtsWordTiming[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.text !== "string"
      || typeof item.startSeconds !== "number" || !Number.isFinite(item.startSeconds)
      || typeof item.endSeconds !== "number" || !Number.isFinite(item.endSeconds)
      || item.startSeconds < 0 || item.endSeconds < item.startSeconds) return null;
    timings.push({ text: item.text, startSeconds: item.startSeconds, endSeconds: item.endSeconds });
  }
  return timings;
}
