// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  CUE_LIMITS,
  planCaptionCues,
  type CaptionNarrationCue,
} from "../../packages/core/src/domain/plan-caption-cues";

function cue(
  start: number,
  words: Array<[text: string, startSeconds: number, endSeconds: number]>,
): CaptionNarrationCue {
  return {
    start,
    words: words.map(([text, startSeconds, endSeconds]) => ({ text, startSeconds, endSeconds })),
  };
}

describe("planCaptionCues", () => {
  it("keeps exactly 84 Unicode code points and splits before the word that would exceed the limit", () => {
    const first = "😀".repeat(42);
    const second = "đ".repeat(41);
    const planned = planCaptionCues([
      cue(0, [[first, 0, 0.4], [second, 0.4, 0.8], ["x", 0.8, 1]]),
    ], 5);

    expect([...planned[0]!.text]).toHaveLength(CUE_LIMITS.maxChars);
    expect(planned.map((item) => item.words.map((word) => word.text))).toEqual([
      [first, second],
      ["x"],
    ]);
  });

  it("keeps an exact seven-second cue and splits before a word that would exceed it", () => {
    const planned = planCaptionCues([
      cue(0, [["một", 0, 3.5], ["hai", 3.5, 7], ["ba", 7, 7.2]]),
    ], 10);

    expect(planned.map((item) => ({ start: item.start, end: item.end, text: item.text }))).toEqual([
      { start: 0, end: 7, text: "một hai" },
      { start: 7, end: 8.2, text: "ba" },
    ]);
  });

  it("splits on a silence of exactly 0.6 seconds and on sentence boundaries", () => {
    const silence = planCaptionCues([
      cue(0, [["Một", 0, 0.2], ["hai", 0.8, 1]]),
    ], 4);
    expect(silence.map((item) => item.text)).toEqual(["Một", "hai"]);
    expect(silence[0]).toMatchObject({ start: 0, end: 0.8 });

    const sentences = planCaptionCues([
      cue(0, [["Xin", 0, 0.2], ["chào!", 0.2, 0.5], ["Bạn", 0.5, 0.8]]),
    ], 4);
    expect(sentences.map((item) => item.text)).toEqual(["Xin chào!", "Bạn"]);
  });

  it("applies the 1.2-second floor by extending into a gap, then clamps at the next cue or scene end", () => {
    expect(planCaptionCues([
      cue(0, [["Ngắn.", 0, 0.3], ["Sau", 2, 2.2]]),
    ], 5)).toMatchObject([
      { start: 0, end: 1.2, text: "Ngắn." },
      { start: 2, end: 3.2, text: "Sau" },
    ]);

    expect(planCaptionCues([
      cue(0, [["Ngắn.", 0, 0.3], ["Sát", 0.8, 1]]),
    ], 5)).toMatchObject([
      { start: 0, end: 0.8, text: "Ngắn." },
      { start: 0.8, end: 2, text: "Sát" },
    ]);

    expect(planCaptionCues([cue(0, [["Cuối", 0, 0.2]])], 0.7)).toMatchObject([
      { start: 0, end: 0.7, text: "Cuối" },
    ]);
  });

  it("never merges across narration cues and rebases relative words exactly once", () => {
    const planned = planCaptionCues([
      cue(5, [["một", 0.2, 0.5]]),
      cue(5.6, [["hai", 0.1, 0.4]]),
    ], 8);

    expect(planned).toEqual([
      {
        start: 5.2,
        end: 5.7,
        text: "một",
        words: [{ text: "một", start: 5.2, end: 5.5 }],
      },
      {
        start: 5.7,
        end: 6.9,
        text: "hai",
        words: [{ text: "hai", start: 5.7, end: 6 }],
      },
    ]);
  });

  it("keeps punctuation attached and joins canonical cue text with one U+0020", () => {
    const planned = planCaptionCues([
      cue(0, [["Xin", 0, 0.2], ["chào,", 0.2, 0.4], ["Việt", 0.4, 0.6], ["Nam.", 0.6, 0.8]]),
    ], 3);

    expect(planned[0]!.text).toBe("Xin chào, Việt Nam.");
    expect(planned[0]!.words.map((word) => word.text)).toEqual(["Xin", "chào,", "Việt", "Nam."]);
  });
});
