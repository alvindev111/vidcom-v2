import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import { prepareTtsSpeechText } from "@vidcom/core";

const withEmotion = { supportsEmotionCues: true };
const withoutEmotion = { supportsEmotionCues: false };

function speech(text: string, options = withEmotion): string {
  const prepared = prepareTtsSpeechText(text, options);
  if (!prepared.ok) throw new Error(`expected success, got ${prepared.error.code}`);
  return prepared.value;
}

describe("prepareTtsSpeechText", () => {
  it("turns a short pause into a comma when no punctuation precedes it", () => {
    expect(speech("Xin chào [ngắt ngắn] các bạn")).toBe("Xin chào, các bạn");
  });

  it("keeps the author's own punctuation instead of adding a second mark", () => {
    expect(speech("Xin chào. [ngắt ngắn] Các bạn")).toBe("Xin chào. Các bạn");
  });

  it("promotes a medium pause to a full stop", () => {
    expect(speech("Phần một [ngắt vừa] phần hai")).toBe("Phần một. phần hai");
  });

  it("promotes a long pause to a paragraph break", () => {
    expect(speech("Phần một [ngắt dài] phần hai")).toBe("Phần một.\n\nphần hai");
  });

  it("does not stack a comma in front of terminal punctuation", () => {
    expect(speech("Kết thúc [ngắt ngắn].")).toBe("Kết thúc.");
  });

  it("leaves emotion cues in place for a voice that can act them", () => {
    expect(speech("Thật là [cười] buồn cười")).toBe("Thật là [cười] buồn cười");
  });

  it("rejects an emotion cue on a voice that would read it aloud", () => {
    const prepared = prepareTtsSpeechText("Thật là [cười] buồn cười", withoutEmotion);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe(ErrorCode.TtsVoiceNotSupported);
    expect(prepared.error.details).toMatchObject({ cue: "[cười]" });
  });

  it("still resolves pause cues for a voice without emotion support", () => {
    expect(speech("Một [ngắt ngắn] hai", withoutEmotion)).toBe("Một, hai");
  });

  it("collapses the runs of spaces that cue removal leaves behind", () => {
    expect(speech("Một  [ngắt ngắn]   hai")).toBe("Một, hai");
  });
});
