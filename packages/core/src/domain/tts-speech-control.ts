import { ErrorCode, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";

/** Inline cues an author writes into narration text to shape delivery. */
export const TTS_EMOTION_CUES = ["[cười]", "[thở dài]", "[hắng giọng]"] as const;
export const TTS_PAUSE_CUES = ["[ngắt ngắn]", "[ngắt vừa]", "[ngắt dài]"] as const;

export interface PrepareTtsSpeechTextOptions {
  /** Whether the selected voice can act an emotion cue instead of reading it aloud. */
  supportsEmotionCues: boolean;
}

/**
 * Narration text rewritten into what the engine should actually receive, or a
 * `tts_voice_not_supported` error when the text uses an emotion cue the chosen
 * voice cannot act.
 *
 * Pause cues become punctuation rather than SSML: the engines disagree on SSML
 * dialects, but all of them lengthen a pause at a comma, a full stop and a
 * paragraph break, so punctuation is the one control that travels. Emotion cues
 * are left in place for engines that understand them — the provider adapter
 * translates them into its own tag syntax.
 *
 * Pure; the caller decides what to do with the rejection.
 */
export function prepareTtsSpeechText(
  text: string,
  options: PrepareTtsSpeechTextOptions,
): Result<string, DomainError> {
  const emotionCue = TTS_EMOTION_CUES.find((cue) => text.includes(cue));
  if (emotionCue && !options.supportsEmotionCues) {
    return err({
      code: ErrorCode.TtsVoiceNotSupported,
      message: `${emotionCue} needs a voice that supports emotion cues — pick one, or remove the cue from the narration`,
      field: "voiceId",
      details: { cue: emotionCue },
    });
  }
  return ok(text
    .replace(/([,;:.!?]?)\s*\[ngắt ngắn\]\s*/gu, (_match, punctuation: string) => (
      punctuation ? `${punctuation} ` : ", "
    ))
    .replace(/([,;:.!?]?)\s*\[ngắt vừa\]\s*/gu, (_match, punctuation: string) => (
      `${/[.!?]/u.test(punctuation) ? punctuation : "."} `
    ))
    .replace(/([,;:.!?]?)\s*\[ngắt dài\]\s*/gu, (_match, punctuation: string) => (
      `${/[.!?]/u.test(punctuation) ? punctuation : "."}\n\n`
    ))
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/,\s*([.!?])/gu, "$1")
    .trim());
}
