import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ErrorCode, type TtsProviderDto, type TtsVoiceDto } from "@vidcom/contracts";
import type { TtsSynthesisRequest, TtsWordTiming } from "@vidcom/core";

import {
  TtsProviderError,
  type RawCueAudio,
  type TtsProviderAdapter,
  type TtsProviderContext,
} from "./tts-provider";

const PROVIDER_ID = "elevenlabs";
const MODEL_ID = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";

/** 120 s per cue: a long paragraph on a busy day, well short of the job's own ceiling. */
const REQUEST_TIMEOUT_SECONDS = 120;

/** An MP3 frame header alone exceeds this; anything smaller is an empty generation. */
const MINIMUM_AUDIO_BYTES = 256;

/** v3 acts on bracketed English audio tags; the authored Vietnamese cues map onto them. */
const EMOTION_TAGS = new Map([
  ["[cười]", "[laughs]"],
  ["[thở dài]", "[sighs]"],
  ["[hắng giọng]", "[clears throat]"],
] as const);

/**
 * Stock library voices, as a starting point rather than a limit — an account's
 * cloned voices are the ones users actually want, and those arrive through
 * `allowsCustomVoiceId`. `language` is the voice's own training language; the
 * language actually spoken comes from the request, since v3 is multilingual.
 */
const STOCK_VOICES: readonly Omit<TtsVoiceDto, "providerId">[] = [
  // All four are recommended: this list is already VidCom's shortlist out of the
  // hundreds the library carries. An account's cloned voices arrive unlisted and
  // therefore unrecommended, which is right — VidCom has never heard them.
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", language: "en", modelId: MODEL_ID, supportsEmotionCues: true, computeDevices: ["cpu"], recommended: true },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", language: "en", modelId: MODEL_ID, supportsEmotionCues: true, computeDevices: ["cpu"], recommended: true },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam", language: "en", modelId: MODEL_ID, supportsEmotionCues: true, computeDevices: ["cpu"], recommended: true },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni", language: "en", modelId: MODEL_ID, supportsEmotionCues: true, computeDevices: ["cpu"], recommended: true },
];

export interface ElevenLabsTtsProviderOptions {
  /** `null` when the runtime has no key; the provider still appears in the catalog as unavailable. */
  apiKey: string | null;
  /** Test seam; the SDK's own `fetch` is used when omitted. */
  fetch?: typeof globalThis.fetch;
}

/**
 * ElevenLabs v3 over the official SDK.
 *
 * Requests character alignment alongside the audio, which is the reason to use
 * this engine for anything that will eventually carry word-level captions.
 * Retries are switched off here on purpose: the job scheduler already retries
 * idempotent TTS work with backoff, and two retry layers turned a rate-limited
 * account into a five-minute stall before any error surfaced.
 */
export class ElevenLabsTtsProvider implements TtsProviderAdapter {
  readonly id = PROVIDER_ID;

  constructor(private readonly options: ElevenLabsTtsProviderOptions) {}

  async describe(): Promise<TtsProviderDto> {
    const hasKey = (this.options.apiKey ?? "").trim().length > 0;
    return {
      id: PROVIDER_ID,
      label: "ElevenLabs v3",
      available: hasKey,
      unavailableReason: hasKey ? null : "credential_missing",
      voices: STOCK_VOICES.map((voice) => ({ ...voice, providerId: PROVIDER_ID })),
      allowsCustomVoiceId: true,
      customVoiceDefaults: { modelId: MODEL_ID, supportsEmotionCues: true, computeDevices: ["cpu"] },
    };
  }

  async synthesize(
    request: TtsSynthesisRequest,
    context: TtsProviderContext,
  ): Promise<readonly RawCueAudio[]> {
    const client = await this.client();
    const speed = 1 + request.ratePercent / 100;
    const produced: RawCueAudio[] = [];
    for (const [index, cue] of request.cues.entries()) {
      context.signal?.throwIfAborted();
      const generated = await convert(client, {
        voiceId: request.voiceId,
        text: toAudioTags(cue.text),
        languageCode: request.languageCode,
        speed,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const audio = Buffer.from(generated.audioBase64, "base64");
      if (audio.byteLength < MINIMUM_AUDIO_BYTES) {
        throw new TtsProviderError(`ElevenLabs returned no usable audio for scene ${cue.id}`);
      }
      const filePath = join(context.scratchDir, `${cue.id}.elevenlabs.mp3`);
      await writeFile(filePath, audio);
      produced.push({
        cueId: cue.id,
        filePath,
        words: toWordTimings(generated.alignment ?? generated.normalizedAlignment),
        // v3 applies `speed` server-side, so re-applying atempo would square it.
        rateApplied: true,
        metadata: { modelId: MODEL_ID, outputFormat: OUTPUT_FORMAT, effectiveRatePercent: request.ratePercent },
      });
      context.onCueDone?.(index + 1, request.cues.length);
    }
    return produced;
  }

  /**
   * A configured client, with the SDK loaded on first use.
   *
   * Imported dynamically because `@vidcom/adapter` is a barrel: a static import
   * here made every consumer pay the SDK's module-load cost, including
   * `vidcom mcp`, whose startup latency an AI host waits on before its first
   * handshake completes. Nothing short of real synthesis needs it.
   */
  private async client(): Promise<ElevenLabsClient> {
    const apiKey = (this.options.apiKey ?? "").trim();
    if (!apiKey) {
      throw new TtsProviderError(
        "ElevenLabs needs an API key — set ELEVENLABS_API_KEY before generating narration",
        ErrorCode.TtsCredentialMissing,
      );
    }
    const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
    return new ElevenLabsClient({
      apiKey,
      maxRetries: 0,
      timeoutInSeconds: REQUEST_TIMEOUT_SECONDS,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
}

type ElevenLabsSdk = Awaited<typeof import("@elevenlabs/elevenlabs-js")>;
type ElevenLabsClient = InstanceType<ElevenLabsSdk["ElevenLabsClient"]>;

interface ConvertInput {
  voiceId: string;
  text: string;
  languageCode: string;
  speed: number;
  signal?: AbortSignal;
}

async function convert(client: ElevenLabsClient, input: ConvertInput) {
  try {
    return await client.textToSpeech.convertWithTimestamps(input.voiceId, {
      text: input.text,
      modelId: MODEL_ID,
      languageCode: input.languageCode,
      outputFormat: OUTPUT_FORMAT,
      voiceSettings: { speed: input.speed },
    }, { abortSignal: input.signal, timeoutInSeconds: REQUEST_TIMEOUT_SECONDS, maxRetries: 0 });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw toProviderError(error);
  }
}

/**
 * Maps the account-facing failure modes onto codes the UI can act on.
 *
 * Reads `statusCode` structurally rather than testing `instanceof
 * ElevenLabsError`: the class would have to be imported eagerly to be used in an
 * `instanceof`, which is exactly the module-load cost the lazy client avoids.
 */
function toProviderError(error: unknown): TtsProviderError {
  const status = typeof error === "object" && error !== null && "statusCode" in error
    && typeof (error as { statusCode: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : undefined;
  if (status === 401 || status === 403) {
    return new TtsProviderError(
      "ElevenLabs rejected the API key or the selected voice — check ELEVENLABS_API_KEY and that the voice is shared with it",
      ErrorCode.TtsCredentialMissing,
      { cause: error },
    );
  }
  if (status === 402 || status === 429) {
    return new TtsProviderError(
      "ElevenLabs credits or rate limit are exhausted — wait, or top the account up before retrying",
      ErrorCode.TtsQuotaExceeded,
      { cause: error },
    );
  }
  return new TtsProviderError("ElevenLabs narration synthesis failed", ErrorCode.TtsSynthesisFailed, { cause: error });
}

/** Rewrites the authored Vietnamese emotion cues as the v3 audio tags the model acts on. */
function toAudioTags(text: string): string {
  let prepared = text;
  for (const [cue, tag] of EMOTION_TAGS) prepared = prepared.replaceAll(cue, tag);
  return prepared;
}

interface CharacterAlignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

/**
 * Character alignment folded into word timings, or an empty array when the
 * response is unusable.
 *
 * Returns nothing rather than partial timings on any inconsistency: a caption
 * track built from half-correct boundaries drifts visibly, which is worse than
 * having no word timings and falling back to cue-level captions. Audio tags are
 * dropped — the model does not speak them, but it does emit characters for them.
 */
function toWordTimings(alignment: CharacterAlignment | undefined): TtsWordTiming[] {
  if (!alignment) return [];
  const { characters, characterStartTimesSeconds, characterEndTimesSeconds } = alignment;
  if (
    characters.length !== characterStartTimesSeconds.length
    || characters.length !== characterEndTimesSeconds.length
  ) return [];

  const tagIndexes = audioTagIndexes(characters);
  const words: TtsWordTiming[] = [];
  let current: TtsWordTiming | undefined;
  for (const [index, character] of characters.entries()) {
    const startSeconds = characterStartTimesSeconds[index];
    const endSeconds = characterEndTimesSeconds[index];
    if (
      startSeconds === undefined || endSeconds === undefined
      || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
      || startSeconds < 0 || endSeconds < startSeconds
    ) return [];
    if (tagIndexes.has(index)) {
      if (!tagIndexes.has(index - 1) && current) {
        words.push(current);
        current = undefined;
      }
      continue;
    }
    if (/^\s$/u.test(character)) {
      if (current) words.push(current);
      current = undefined;
      continue;
    }
    current = current
      ? { ...current, text: current.text + character, endSeconds: Math.max(current.endSeconds, endSeconds) }
      : { text: character, startSeconds, endSeconds };
  }
  if (current) words.push(current);

  const normalized: TtsWordTiming[] = [];
  let previousEndSeconds = 0;
  for (const word of words) {
    const startSeconds = rounded(Math.max(previousEndSeconds, word.startSeconds));
    const endSeconds = rounded(Math.max(startSeconds, word.endSeconds));
    if (endSeconds <= startSeconds) continue;
    normalized.push({ ...word, startSeconds, endSeconds });
    previousEndSeconds = endSeconds;
  }
  return normalized;
}

/** Character positions covered by a `[tag]` the model did not speak. */
function audioTagIndexes(characters: readonly string[]): ReadonlySet<number> {
  const omitted = new Set<number>();
  const text = characters.join("");
  for (const tag of EMOTION_TAGS.values()) {
    let from = text.indexOf(tag);
    while (from >= 0) {
      for (let index = from; index < from + tag.length; index += 1) omitted.add(index);
      from = text.indexOf(tag, from + tag.length);
    }
  }
  return omitted;
}

function rounded(seconds: number): number {
  return Math.round(seconds * 1_000) / 1_000;
}
