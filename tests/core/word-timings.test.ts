import { describe, expect, it } from "vitest";

import { checkWordTimings, resolveWordTimings } from "@vidcom/core";

describe("resolveWordTimings", () => {
  it("keeps the engine's own timings and says so", () => {
    const engineWords = [
      { text: "Xin", startSeconds: 0, endSeconds: 0.4 },
      { text: "chào", startSeconds: 0.4, endSeconds: 0.9 },
    ];

    const resolved = resolveWordTimings({ engineWords, text: "Xin chào", durationSeconds: 1 });

    expect(resolved).toEqual({ words: engineWords, source: "engine" });
  });

  it("apportions timings for an engine that reports none", () => {
    // VieNeu has no alignment at all; without this the local Vietnamese engine
    // could never drive word-level highlighting.
    const resolved = resolveWordTimings({
      engineWords: [],
      text: "Xin chào các bạn",
      durationSeconds: 2,
    });

    expect(resolved.source).toBe("estimated");
    expect(resolved.words.map((word) => word.text)).toEqual(["Xin", "chào", "các", "bạn"]);
    expect(resolved.words[0]?.startSeconds).toBe(0);
    expect(resolved.words.at(-1)?.endSeconds).toBe(2);
  });

  it("weights an estimate by word length rather than splitting evenly", () => {
    const resolved = resolveWordTimings({ engineWords: [], text: "và chuyển", durationSeconds: 1 });

    const [first, second] = resolved.words;
    // "chuyển" takes visibly longer to say than "và"; an even split puts the
    // highlight ahead of the voice by the end of a long sentence.
    expect(first!.endSeconds - first!.startSeconds)
      .toBeLessThan(second!.endSeconds - second!.startSeconds);
  });

  it("leaves no gap or overrun at the end of an estimate", () => {
    const resolved = resolveWordTimings({
      engineWords: [],
      text: "một hai ba bốn năm sáu bảy",
      durationSeconds: 3.333,
    });

    expect(resolved.words.at(-1)?.endSeconds).toBe(3.333);
    for (const [index, word] of resolved.words.entries()) {
      if (index === 0) continue;
      expect(word.startSeconds).toBe(resolved.words[index - 1]!.endSeconds);
    }
  });

  it("splits an engine entry that covers a whole phrase", () => {
    const resolved = resolveWordTimings({
      engineWords: [{ text: "xin chào", startSeconds: 1, endSeconds: 2 }],
      text: "xin chào",
      durationSeconds: 2,
    });

    // One contract for consumers, whether the engine reports words or phrases.
    expect(resolved.words.map((word) => word.text)).toEqual(["xin", "chào"]);
    expect(resolved.words[0]?.startSeconds).toBe(1);
    expect(resolved.words.at(-1)?.endSeconds).toBe(2);
  });

  it("does not time the bracketed control cues, which are never spoken", () => {
    const resolved = resolveWordTimings({
      engineWords: [],
      text: "Xin chào [ngắt ngắn] các bạn",
      durationSeconds: 2,
    });

    expect(resolved.words.map((word) => word.text)).toEqual(["Xin", "chào", "các", "bạn"]);
  });

  it("returns nothing for a cue with no words to speak", () => {
    expect(resolveWordTimings({ engineWords: [], text: "[cười]", durationSeconds: 1 }).words).toEqual([]);
  });

  it("returns nothing rather than dividing by a duration it does not have", () => {
    expect(resolveWordTimings({ engineWords: [], text: "xin chào", durationSeconds: 0 }).words).toEqual([]);
  });
});

describe("checkWordTimings", () => {
  it("accepts ordered, in-range timings", () => {
    const result = checkWordTimings([
      { text: "xin", startSeconds: 0, endSeconds: 0.5 },
      { text: "chào", startSeconds: 0.5, endSeconds: 1 },
    ], 1);

    expect(result.ok).toBe(true);
  });

  it("accepts a boundary a millisecond past the duration", () => {
    // Durations and boundaries are rounded independently; an exact comparison
    // rejects timings that are correct to the frame.
    expect(checkWordTimings([{ text: "xin", startSeconds: 0, endSeconds: 1.0005 }], 1).ok).toBe(true);
  });

  it("rejects overlapping words", () => {
    const result = checkWordTimings([
      { text: "xin", startSeconds: 0, endSeconds: 0.6 },
      { text: "chào", startSeconds: 0.5, endSeconds: 1 },
    ], 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("starts before the previous one ends");
  });

  it("rejects a word that ends after its audio", () => {
    const result = checkWordTimings([{ text: "xin", startSeconds: 0, endSeconds: 5 }], 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("ends after its audio");
  });

  it("rejects a zero-length or reversed range", () => {
    expect(checkWordTimings([{ text: "xin", startSeconds: 1, endSeconds: 1 }], 2).ok).toBe(false);
    expect(checkWordTimings([{ text: "xin", startSeconds: 2, endSeconds: 1 }], 2).ok).toBe(false);
  });

  it("rejects a timed word with no text", () => {
    expect(checkWordTimings([{ text: "  ", startSeconds: 0, endSeconds: 1 }], 1).ok).toBe(false);
  });

  it("accepts an empty list, which means the cue had nothing to speak", () => {
    expect(checkWordTimings([], 1).ok).toBe(true);
  });
});
