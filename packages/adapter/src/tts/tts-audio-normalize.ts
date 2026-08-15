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

/**
 * 15 ms taper on each end of the speech.
 *
 * The trim cuts at whatever sample crossed the threshold, which is rarely near
 * zero — and a waveform that starts mid-swing is a click. Short enough that it
 * softens nothing audible, long enough to remove the transient.
 */
const EDGE_FADE = "afade=t=in:st=0:d=0.015";

/**
 * Trims and tapers both ends in a single reversed section.
 *
 * `areverse` buffers the entire cue, so doing it twice for the trim and twice
 * more for the fade would quadruple that for no benefit: once the stream is
 * backwards, the tail trim and the tail fade are both just leading operations.
 */
const SILENCE_TRIM_FILTER = [
  LEADING_SILENCE_TRIM,
  "areverse",
  LEADING_SILENCE_TRIM,
  EDGE_FADE,
  "areverse",
  EDGE_FADE,
].join(",");

/** 44.1 kHz mono: what the composition schedule mixes at, and what every provider must land on. */
export const NARRATION_SAMPLE_RATE = 44_100;

/**
 * Silence added at each end of every cue, in seconds.
 *
 * The trim leaves speech starting on its first audible sample, which is correct
 * for measuring a cue and wrong for playing several in a row: consecutive clips
 * ran into each other with no breath between them, and a listener hears that as
 * the narrator stumbling at a scene change. Two adjacent cues therefore sit
 * `2 × this` apart, which is about the gap between spoken sentences.
 *
 * Exported because it is part of the published contract: engine word timings are
 * shifted by it, and the composition schedule places clips that carry it.
 */
export const NARRATION_EDGE_PAD_SECONDS = 0.12;

/**
 * -16 LUFS integrated, -1.5 dBTP.
 *
 * The broadcast target for mono speech. Absolute rather than relative because the
 * point is cross-engine equality: a local engine's raw output and a cloud
 * engine's MP3 arrive up to 20 dB apart, and two clips at different levels read
 * as two different speakers far more strongly than as a volume change.
 */
const TARGET_LUFS = -16;
const TARGET_TRUE_PEAK_DBTP = -1.5;
/** 11 LU, the EBU R128 default. Narration has little dynamic range to preserve. */
const TARGET_LOUDNESS_RANGE = 11;

const EDGE_PAD_FILTER = [
  `adelay=${Math.round(NARRATION_EDGE_PAD_SECONDS * 1_000)}:all=1`,
  `apad=pad_dur=${NARRATION_EDGE_PAD_SECONDS}`,
].join(",");

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
  /** Full published length, pad at both ends included — what the timeline schedules. */
  durationSeconds: number;
  /**
   * Length of the speech between the pads.
   *
   * Separate from `durationSeconds` because engine word timings map onto the
   * speech, not onto the published file: scaling them by the padded duration
   * stretches every timestamp by the pad.
   */
  speechDurationSeconds: number;
  /**
   * Seconds of silence removed from the front of the engine's output.
   *
   * Engine word timings are relative to the untrimmed audio, so every one of
   * them is late by exactly this much once the padding is gone. 0 when not
   * measured.
   */
  trimStartSeconds: number;
  /**
   * Seconds of silence now in front of the speech.
   *
   * The other half of the timing correction, and the reason both numbers are
   * reported: a caller that subtracts the trim without adding the pad back moves
   * every word earlier than the audio it labels — which only shows up on engines
   * that report timings at all.
   */
  leadPadSeconds: number;
}

/**
 * Rewrites one engine output as trimmed, level-matched, padded 44.1 kHz mono WAV.
 *
 * Every provider goes through here, including ones that already emit WAV — that
 * is the whole point: a cue's duration, format and loudness must not depend on
 * which engine produced it, or the same narration lands on the timeline at a
 * different length and a different volume after switching voices.
 *
 * Runs FFmpeg three times (measure loudness, convert, and — only when the engine
 * reported word timings — measure the leading trim) plus FFprobe. Throws
 * `TtsProviderError` when the toolchain is missing (`tts_provider_unavailable`),
 * when the loudness cannot be measured, or when the result is too small to be
 * speech.
 */
export async function normalizeCueAudio(
  processes: ProcessPort,
  input: NormalizeCueAudioInput,
): Promise<NormalizedCueAudio> {
  const target = join(input.scratchDir, `${input.cueId}.normalized.wav`);
  const tempo = 1 + input.ratePercent / 100;
  // atempo below 0.5 or above 2.0 is silently ignored by FFmpeg, but the
  // contract already clamps rate to -10..+20%, so one stage always suffices.
  // It runs before the loudness stage so the measured level is the level of the
  // audio actually published, and before the pad so speeding a cue up shortens
  // the speech rather than the breathing room.
  const speechFilter = input.ratePercent === 0
    ? SILENCE_TRIM_FILTER
    : `${SILENCE_TRIM_FILTER},atempo=${tempo.toFixed(3)}`;

  const loudness = await measureLoudness(processes, input, speechFilter);
  const converted = await run(processes, [
    "ffmpeg", "-y", "-v", "error",
    "-i", input.sourcePath,
    "-af", `${speechFilter},${loudness},${EDGE_PAD_FILTER}`,
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
  const durationSeconds = await probeDuration(processes, target, input.signal);
  return {
    path: target,
    durationSeconds,
    // Derived rather than probed again: the pad is inserted as exact sample
    // counts, so subtracting what was added is accurate to well under a
    // millisecond and costs no extra FFprobe pass.
    speechDurationSeconds: Math.max(0, rounded(durationSeconds - 2 * NARRATION_EDGE_PAD_SECONDS)),
    trimStartSeconds: input.measureTrimStart ? await measureTrimStart(processes, input) : 0,
    leadPadSeconds: NARRATION_EDGE_PAD_SECONDS,
  };
}

/**
 * The `loudnorm` stage, with this cue's level already measured.
 *
 * Two passes, not one. A single-pass `loudnorm` normalizes as it goes and lands
 * each cue somewhere different, which is the defect this exists to remove rather
 * than a cheaper way to fix it. Measuring first and then applying `linear=true`
 * makes the correction one constant gain per cue, so the level is equal across
 * cues and the dynamics inside each one are untouched.
 *
 * The measurement runs the same `speechFilter` the conversion will, so the two
 * can never disagree about what was measured.
 */
async function measureLoudness(
  processes: ProcessPort,
  input: NormalizeCueAudioInput,
  speechFilter: string,
): Promise<string> {
  const target = `I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK_DBTP}:LRA=${TARGET_LOUDNESS_RANGE}`;
  const measured = await run(processes, [
    // loudnorm prints its summary at info level on stderr, so `-v error` — used
    // everywhere else here — would discard the only output this pass produces.
    "ffmpeg", "-y", "-hide_banner", "-nostats", "-v", "info",
    "-i", input.sourcePath,
    "-af", `${speechFilter},loudnorm=${target}:print_format=json`,
    "-f", "null", "-",
  ], input.signal);
  if (measured.exitCode !== 0) {
    throw new TtsProviderError(
      `narration audio for ${input.cueId} could not be measured for loudness: ${measured.stderr.trim() || "ffmpeg failed"}`,
    );
  }

  const summary = parseLoudnessSummary(measured.stderr);
  if (!summary) {
    throw new TtsProviderError(
      `FFmpeg reported no loudness summary for ${input.cueId} — the installed build cannot run the loudnorm filter, so narration levels cannot be matched across scenes`,
      ErrorCode.TtsProviderUnavailable,
    );
  }
  // `-inf` integrated loudness means the filter found nothing above its gate:
  // the engine returned silence, and normalizing it would amplify the noise
  // floor to speech level.
  if (!Number.isFinite(summary.input_i)) {
    throw new TtsProviderError(`the engine produced no usable audio for ${input.cueId}`);
  }
  return [
    `loudnorm=${target}`,
    `measured_I=${summary.input_i}`,
    `measured_TP=${summary.input_tp}`,
    `measured_LRA=${summary.input_lra}`,
    `measured_thresh=${summary.input_thresh}`,
    `offset=${summary.target_offset}`,
    // One constant gain for the whole cue. Without it the filter is free to ride
    // the level within a cue, which reintroduces exactly the wandering volume
    // the two-pass measurement is here to remove.
    "linear=true",
  ].join(":");
}

interface LoudnessSummary {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

/**
 * The measured values from a `print_format=json` pass, or `null` when the build
 * printed no summary.
 *
 * Reads the last JSON object in the log rather than the first: FFmpeg prints the
 * filter graph before it, and a second `loudnorm` in the chain would print its
 * own. Values arrive as quoted strings, and any of them may be `-inf`.
 */
function parseLoudnessSummary(log: string): LoudnessSummary | null {
  const opened = log.lastIndexOf("{");
  const closed = log.lastIndexOf("}");
  if (opened < 0 || closed < opened) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(log.slice(opened, closed + 1)); }
  catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const summary: Partial<LoudnessSummary> = {};
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const) {
    const raw = record[key];
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    summary[key] = Number.parseFloat(String(raw));
  }
  return summary as LoudnessSummary;
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
    return Math.max(0, rounded(source - withoutLeading));
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
  return rounded(seconds);
}

function rounded(seconds: number): number {
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
