import type { TtsWordTiming } from "../port/tts-port";

export interface CaptionWord {
  text: string;
  /** Absolute within the scene. */
  start: number;
  /** Absolute within the scene. */
  end: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  words: CaptionWord[];
  text: string;
}

export interface CaptionNarrationCue {
  /** Narration-cue offset within the scene. */
  start: number;
  /** Timings relative to this narration cue. */
  words: readonly TtsWordTiming[];
}

export const CUE_LIMITS = Object.freeze({
  maxChars: 84,
  maxSeconds: 7,
  minSeconds: 1.2,
  silenceGap: 0.6,
});

export type CaptionCueLimits = typeof CUE_LIMITS;

interface PlannedCue extends CaptionCue {
  narrationIndex: number;
}

const SENTENCE_END = /[.!?…](?:["'”’)}\]»]+)?$/u;

/**
 * Converts narration-relative word timings into bounded, non-overlapping scene cues.
 * Pure: persisted cue fields and composition serialization stay outside this planner.
 */
export function planCaptionCues(
  narrationCues: readonly CaptionNarrationCue[],
  sceneEnd: number,
  limits: CaptionCueLimits = CUE_LIMITS,
): CaptionCue[] {
  validateInputs(narrationCues, sceneEnd, limits);
  const planned: PlannedCue[] = [];

  narrationCues.forEach((narrationCue, narrationIndex) => {
    let current: CaptionWord[] = [];
    const flush = () => {
      if (current.length === 0) return;
      planned.push(toCue(current, narrationIndex));
      current = [];
    };

    for (const relativeWord of narrationCue.words) {
      // This is the only relative-to-scene rebase in the caption pipeline.
      const start = rounded(narrationCue.start + relativeWord.startSeconds);
      const end = rounded(Math.min(sceneEnd, narrationCue.start + relativeWord.endSeconds));
      if (start >= sceneEnd) break;
      if (!(end > start)) continue;
      const word: CaptionWord = { text: relativeWord.text, start, end };

      if (current.length > 0) {
        const previous = current.at(-1)!;
        const candidateText = canonicalText([...current, word]);
        const crossesLimit = codePointLength(candidateText) > limits.maxChars
          || word.end - current[0]!.start > limits.maxSeconds;
        const crossesSilence = word.start - previous.end >= limits.silenceGap;
        if (crossesLimit || crossesSilence) flush();
      }

      current.push(word);
      if (SENTENCE_END.test(word.text)) flush();
    }
    flush();
  });

  planned.sort((left, right) => left.start - right.start || left.narrationIndex - right.narrationIndex);
  return planned.map((cue, index): CaptionCue => {
    const next = planned[index + 1];
    if (next && cue.end > next.start) {
      throw new TypeError("caption word timings overlap");
    }
    // Greedy grouping above first consumes every same-sentence/same-narration
    // word that fits. Only then may the display window use otherwise empty time.
    const floor = rounded(cue.start + limits.minSeconds);
    const boundary = Math.min(sceneEnd, next?.start ?? sceneEnd);
    const end = rounded(Math.min(Math.max(cue.end, floor), boundary));
    return { start: cue.start, end, words: cue.words, text: cue.text };
  });
}

function toCue(words: CaptionWord[], narrationIndex: number): PlannedCue {
  return {
    narrationIndex,
    start: words[0]!.start,
    end: words.at(-1)!.end,
    words,
    text: canonicalText(words),
  };
}

function canonicalText(words: readonly Pick<CaptionWord, "text">[]): string {
  return words.map((word) => word.text).join(" ");
}

function codePointLength(value: string): number {
  return [...value].length;
}

function validateInputs(
  narrationCues: readonly CaptionNarrationCue[],
  sceneEnd: number,
  limits: CaptionCueLimits,
): void {
  if (!Number.isFinite(sceneEnd) || sceneEnd < 0) throw new TypeError("caption scene end must be finite and non-negative");
  if (!Number.isFinite(limits.maxChars) || limits.maxChars < 1
    || !Number.isFinite(limits.maxSeconds) || limits.maxSeconds <= 0
    || !Number.isFinite(limits.minSeconds) || limits.minSeconds < 0
    || !Number.isFinite(limits.silenceGap) || limits.silenceGap < 0) {
    throw new TypeError("caption cue limits are invalid");
  }
  for (const cue of narrationCues) {
    if (!Number.isFinite(cue.start) || cue.start < 0) throw new TypeError("caption narration start is invalid");
    let previousEnd = 0;
    for (const word of cue.words) {
      if (!word.text.trim() || !Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds)
        || word.startSeconds < previousEnd || word.endSeconds <= word.startSeconds) {
        throw new TypeError("caption narration word timing is invalid");
      }
      previousEnd = word.endSeconds;
    }
  }
}

function rounded(seconds: number): number {
  return Math.round(seconds * 1_000_000) / 1_000_000;
}
