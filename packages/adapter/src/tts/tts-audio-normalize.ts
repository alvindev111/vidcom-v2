import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { ErrorCode } from "@vidcom/contracts";
import type { ProcessPort } from "@vidcom/core";

import { TtsProviderError } from "./tts-provider";

/**
 * Trims dead air from both ends without eating a soft opening consonant.
 *
 * `-50dB` rather than a higher floor: Vietnamese unvoiced initials ("kh", "th")
 * start well below a speech-level threshold, and trimming at -35dB clipped them
 * off, which read as a mispronunciation rather than a timing bug.
 */
const LEADING_SILENCE_TRIM =
  "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB";

const SILENCE_TRIM_FILTER = [
  LEADING_SILENCE_TRIM,
  "areverse",
  LEADING_SILENCE_TRIM,
  "areverse",
].join(",");

/** 44.1 kHz mono: what the composition schedule mixes at, and what every provider must land on. */
export const NARRATION_SAMPLE_RATE = 44_100;

/** A WAV header alone is 44 bytes; anything this small is a failed generation, not short speech. */
const MINIMUM_AUDIO_BYTES = 1_024;

export interface NormalizeCueAudioInput {
  sourcePath: string;
  scratchDir: string;
  cueId: string;
  /** Applied as `atempo`; pass 0 when the engine already honoured the requested rate. */
  ratePercent: number;
  /**
   * Whether to measure how much leading silence the trim removed. Costs one
   * extra FFmpeg pass, so it is only worth it when the engine returned word
   * timings that have to be rebased onto the trimmed audio.
   */
  measureTrimStart?: boolean;
  signal?: AbortSignal;
}

export interface NormalizedCueAudio {
  path: string;
  durationSeconds: number;
  /**
   * Seconds of silence removed from the front, or 0 when not measured.
   *
   * Engine word timings are relative to the untrimmed audio, so every one of
   * them is late by exactly this much once the padding is gone.
   */
  trimStartSeconds: number;
}

/**
 * Rewrites one engine output as trimmed 44.1 kHz mono WAV and measures it.
 *
 * Every provider goes through here, including ones that already emit WAV — that
 * is the whole point: a cue's duration and format must not depend on which
 * engine produced it, or the same narration lands on the timeline at a
 * different length after switching voices.
 *
 * Runs FFmpeg and FFprobe. Throws `TtsProviderError` when either is missing
 * (`tts_provider_unavailable`) or the result is too small to be speech.
 */
export async function normalizeCueAudio(
  processes: ProcessPort,
  input: NormalizeCueAudioInput,
): Promise<NormalizedCueAudio> {
  const target = join(input.scratchDir, `${input.cueId}.normalized.wav`);
  const tempo = 1 + input.ratePercent / 100;
  // atempo below 0.5 or above 2.0 is silently ignored by FFmpeg, but the
  // contract already clamps rate to -10..+20%, so one stage always suffices.
  const filter = input.ratePercent === 0
    ? SILENCE_TRIM_FILTER
    : `${SILENCE_TRIM_FILTER},atempo=${tempo.toFixed(3)}`;

  const converted = await run(processes, [
    "ffmpeg", "-y", "-v", "error",
    "-i", input.sourcePath,
    "-af", filter,
    "-ar", String(NARRATION_SAMPLE_RATE), "-ac", "1",
    target,
  ], input.signal);
  if (converted.exitCode !== 0) {
    throw new TtsProviderError(
      `narration audio for ${input.cueId} could not be converted: ${converted.stderr.trim() || "ffmpeg failed"}`,
    );
  }

  const written = await stat(target).catch(() => null);
  if (!written?.isFile() || written.size < MINIMUM_AUDIO_BYTES) {
    throw new TtsProviderError(`the engine produced no usable audio for ${input.cueId}`);
  }
  return {
    path: target,
    durationSeconds: await probeDuration(processes, target, input.signal),
    trimStartSeconds: input.measureTrimStart ? await measureTrimStart(processes, input) : 0,
  };
}

/**
 * Seconds of leading silence the trim filter removes from this source.
 *
 * Measured by trimming only the front and comparing durations, rather than
 * parsing `silencedetect` log lines: the filter that actually runs in the
 * pipeline is the one being measured, so the two can never disagree about where
 * speech starts. Returns 0 if the measurement is not usable — word timings then
 * stay where the engine put them, which is the pre-existing behaviour rather
 * than a new kind of wrong.
 */
async function measureTrimStart(
  processes: ProcessPort,
  input: NormalizeCueAudioInput,
): Promise<number> {
  const probePath = join(input.scratchDir, `${input.cueId}.leading.wav`);
  const trimmed = await run(processes, [
    "ffmpeg", "-y", "-v", "error",
    "-i", input.sourcePath,
    "-af", LEADING_SILENCE_TRIM,
    "-ar", String(NARRATION_SAMPLE_RATE), "-ac", "1",
    probePath,
  ], input.signal);
  if (trimmed.exitCode !== 0) return 0;
  try {
    const [source, withoutLeading] = await Promise.all([
      probeDuration(processes, input.sourcePath, input.signal),
      probeDuration(processes, probePath, input.signal),
    ]);
    return Math.max(0, Math.round((source - withoutLeading) * 1_000) / 1_000);
  } catch {
    return 0;
  } finally {
    await rm(probePath, { force: true });
  }
}

/**
 * Playable duration in seconds, rounded to milliseconds.
 *
 * Reads the decoded stream rather than the container header: a WAV written by a
 * streaming engine can carry a placeholder length in its header while the actual
 * samples say otherwise.
 */
export async function probeDuration(
  processes: ProcessPort,
  path: string,
  signal?: AbortSignal,
): Promise<number> {
  const probed = await run(processes, [
    "ffprobe", "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ], signal);
  const seconds = Number.parseFloat(probed.stdout.trim());
  if (probed.exitCode !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
    throw new TtsProviderError(`narration audio at ${path} could not be measured`);
  }
  return Math.round(seconds * 1_000) / 1_000;
}

/**
 * Whether both FFmpeg and FFprobe can be executed here.
 *
 * Checked before an engine runs, not after: a cloud provider that synthesizes
 * first and normalizes second bills the user for audio that a missing FFmpeg is
 * then guaranteed to throw away.
 */
export async function audioToolchainAvailable(processes: ProcessPort): Promise<boolean> {
  const probe = async (executable: string) => {
    try {
      const output = await processes.run({ command: [executable, "-version"], timeoutMs: 15_000 });
      return output.exitCode === 0;
    } catch { return false; }
  };
  const [ffmpeg, ffprobe] = await Promise.all([probe("ffmpeg"), probe("ffprobe")]);
  return ffmpeg && ffprobe;
}

async function run(processes: ProcessPort, command: readonly string[], signal?: AbortSignal) {
  try {
    return await processes.run({ command, signal, timeoutMs: 120_000 });
  } catch (error) {
    if (signal?.aborted) throw error;
    // spawn throws ENOENT for a missing executable, which is a setup problem the
    // user fixes by installing FFmpeg — not a synthesis failure to retry.
    throw new TtsProviderError(
      `${command[0]} is not available — install FFmpeg and make sure it is on PATH`,
      ErrorCode.TtsProviderUnavailable,
      { cause: error },
    );
  }
}
