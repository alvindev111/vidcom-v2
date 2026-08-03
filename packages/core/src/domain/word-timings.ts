import { ErrorCode, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import type { TtsWordTiming } from "../port/tts-port";

/**
 * How a cue's word boundaries were arrived at.
 *
 * A consumer has to be able to tell these apart. `engine` timings are measured
 * against the audio and can drive per-word highlighting that stays on the
 * syllable; `estimated` ones are apportioned from the cue's own text and drift
 * within a sentence, which is fine for a moving highlight and wrong for anything
 * claiming to be a transcript alignment.
 */
export type WordTimingSource = "engine" | "estimated";

export interface ResolvedWordTimings {
  words: readonly TtsWordTiming[];
  source: WordTimingSource;
}

/** A word shorter than this contributes as if it were this long, so "ở" is not instant. */
const MINIMUM_WORD_WEIGHT = 1;

/**
 * Per-word boundaries for one cue: the engine's own when it reported any,
 * otherwise apportioned across the cue's text.
 *
 * Every engine ends up with word timings this way, which is what makes word-level
 * transcript highlighting possible at all — VieNeu reports no alignment, and
 * without this the local Vietnamese engine could never drive that feature.
 *
 * Apportioning weights each word by its character count rather than splitting the
 * duration evenly: "chuyển" takes visibly longer to say than "và", and an even
 * split puts the highlight ahead of the voice by the end of a long sentence.
 *
 * Pure. `words` is empty only when the text has no words at all.
 */
export function resolveWordTimings(input: {
  engineWords: readonly TtsWordTiming[];
  text: string;
  durationSeconds: number;
}): ResolvedWordTimings {
  if (input.engineWords.length > 0) {
    // Engines can report a phrase per entry rather than a word; splitting those
    // keeps one contract for consumers instead of two.
    return { words: input.engineWords.flatMap(splitTimingIntoWords), source: "engine" };
  }
  const words = spokenWords(input.text);
  if (words.length === 0 || !(input.durationSeconds > 0)) return { words: [], source: "estimated" };
  return {
    words: apportion(words, 0, input.durationSeconds),
    source: "estimated",
  };
}

/**
 * Rejects word timings that could not describe the audio they claim to.
 *
 * Called before the timings are published, because a caption track built from
 * overlapping or out-of-range boundaries drifts visibly and the cause is very
 * hard to see from the symptom.
 */
export function checkWordTimings(
  words: readonly TtsWordTiming[],
  durationSeconds: number,
): Result<void, DomainError> {
  let previousEndSeconds = 0;
  for (const word of words) {
    if (!word.text.trim()) {
      return err({ code: ErrorCode.TtsSynthesisFailed, message: "a timed narration word has no text" });
    }
    if (
      !Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds)
      || word.startSeconds < 0 || word.endSeconds <= word.startSeconds
    ) {
      return err({
        code: ErrorCode.TtsSynthesisFailed,
        message: `narration word "${word.text}" has an impossible time range`,
      });
    }
    if (word.startSeconds < previousEndSeconds) {
      return err({
        code: ErrorCode.TtsSynthesisFailed,
        message: `narration word "${word.text}" starts before the previous one ends`,
      });
    }
    // A millisecond of slack: durations and boundaries are rounded independently,
    // so an exact comparison rejects timings that are correct to the frame.
    if (word.endSeconds > durationSeconds + 0.001) {
      return err({
        code: ErrorCode.TtsSynthesisFailed,
        message: `narration word "${word.text}" ends after its audio does`,
      });
    }
    previousEndSeconds = word.endSeconds;
  }
  return ok(undefined);
}

/** Words as spoken, with the bracketed control cues stripped out. */
function spokenWords(text: string): string[] {
  return text
    .replace(/\[[^\]]*\]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

/** Splits one timing across the words it covers; a single-word timing passes through. */
function splitTimingIntoWords(timing: TtsWordTiming): TtsWordTiming[] {
  const words = spokenWords(timing.text);
  if (words.length <= 1 || timing.endSeconds <= timing.startSeconds) return [timing];
  return apportion(words, timing.startSeconds, timing.endSeconds);
}

/** Lays `words` end to end between the two instants, weighted by length. */
function apportion(words: readonly string[], startSeconds: number, endSeconds: number): TtsWordTiming[] {
  const weights = words.map((word) => Math.max(MINIMUM_WORD_WEIGHT, [...word].length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const span = endSeconds - startSeconds;
  let cursor = startSeconds;
  return words.map((word, index) => {
    // The last word takes the exact end so rounding cannot leave a gap or an
    // overrun at the boundary a caption track is most likely to be judged on.
    const wordEnd = index === words.length - 1
      ? endSeconds
      : cursor + span * (weights[index]! / totalWeight);
    const timing = { text: word, startSeconds: rounded(cursor), endSeconds: rounded(wordEnd) };
    cursor = wordEnd;
    return timing;
  });
}

function rounded(seconds: number): number {
  return Math.round(seconds * 1_000) / 1_000;
}
