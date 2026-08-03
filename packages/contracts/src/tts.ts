import { z } from "zod";

const identifierSchema = z.string().min(1).max(255);

/**
 * Rate is a percentage delta applied to the engine's natural speed. The window
 * is deliberately narrow: past +20% the Vietnamese engines start clipping tone
 * marks, and below -10% ElevenLabs stretches vowels into an audible warble.
 */
export const MIN_TTS_RATE_PERCENT = -10;
export const MAX_TTS_RATE_PERCENT = 20;

/** One narration batch stays a single job; 50 scenes is already several minutes of audio. */
export const MAX_TTS_BATCH_CUES = 50;

/**
 * 255 characters — a UUID with room to spare. The header value is persisted, so
 * an unbounded one is a way to grow the database from a request header.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Where a local model runs. There is deliberately no `auto`: an engine left to
 * choose picks CUDA whenever a driver is present, which turns "my machine got
 * slow" into an unexplainable intermittent. GPU is opt-in and only offered once
 * the provider has probed a usable device. Cloud providers advertise `cpu` and
 * ignore the field.
 */
export const TtsComputeDeviceSchema = z.enum(["cpu", "gpu"]);

/** CPU is what every machine can do; nothing selects GPU without the user asking. */
export const DEFAULT_TTS_COMPUTE_DEVICE = "cpu" as const;

/** Why a registered provider cannot run right now, for a UI that explains instead of hiding. */
export const TtsUnavailableReasonSchema = z.enum([
  "credential_missing",
  "sidecar_missing",
  "audio_toolchain_missing",
]);

export const TtsVoiceSchema = z.strictObject({
  id: identifierSchema,
  providerId: identifierSchema,
  label: z.string().min(1),
  /** ISO 639-1, matching what the engine is trained on rather than the project locale. */
  language: z.string().regex(/^[a-z]{2}$/),
  modelId: identifierSchema,
  supportsEmotionCues: z.boolean(),
  computeDevices: z.array(TtsComputeDeviceSchema).min(1),
  /**
   * Whether VidCom puts this voice forward as a default choice.
   *
   * A curated shortlist, not a quality claim: an engine can ship a dozen usable
   * presets, and a picker that lists all of them equally makes the first
   * narration a research task. `false` means "not on the shortlist", never
   * "avoid".
   */
  recommended: z.boolean(),
});

export const TtsProviderSchema = z.strictObject({
  id: identifierSchema,
  label: z.string().min(1),
  available: z.boolean(),
  unavailableReason: TtsUnavailableReasonSchema.nullable(),
  voices: z.array(TtsVoiceSchema),
  /**
   * Whether a voice id outside `voices` is still worth trying. True for accounts
   * that hold cloned voices the catalog cannot know about; false for engines
   * whose voice set is fixed by the shipped model.
   */
  allowsCustomVoiceId: z.boolean(),
  /** Capabilities applied to a custom voice id, since no catalog entry describes it. */
  customVoiceDefaults: z.strictObject({
    modelId: identifierSchema,
    supportsEmotionCues: z.boolean(),
    computeDevices: z.array(TtsComputeDeviceSchema).min(1),
  }).nullable(),
});

export const ListTtsProvidersResponseSchema = z.strictObject({
  providers: z.array(TtsProviderSchema),
});

/** Fields shared by the HTTP request and the durable job input; the job adds `projectId`. */
const ttsSelectionShape = {
  sceneIds: z.array(identifierSchema).min(1).max(MAX_TTS_BATCH_CUES),
  providerId: identifierSchema,
  voiceId: identifierSchema,
  modelId: identifierSchema.nullish(),
  ratePercent: z.number().int().min(MIN_TTS_RATE_PERCENT).max(MAX_TTS_RATE_PERCENT).nullish(),
  computeDevice: TtsComputeDeviceSchema.nullish(),
};

export const SynthesizeNarrationRequestSchema = z.strictObject(ttsSelectionShape);

export const TtsJobInputSchema = z.strictObject({
  ...ttsSelectionShape,
  projectId: identifierSchema,
});

export const TtsNarrationAssetSchema = z.strictObject({
  sceneId: identifierSchema,
  path: z.string().min(1),
  durationSeconds: z.number().positive(),
});

export const TtsJobResultSchema = z.strictObject({
  assets: z.array(TtsNarrationAssetSchema),
  revision: z.number().int().nonnegative(),
});

/** Enqueue acknowledgement; the audio itself arrives through the job and SSE. */
export const SynthesizeNarrationResponseSchema = z.strictObject({
  jobId: identifierSchema,
  status: z.literal("queued"),
});

export type TtsComputeDeviceDto = z.infer<typeof TtsComputeDeviceSchema>;
export type TtsUnavailableReasonDto = z.infer<typeof TtsUnavailableReasonSchema>;
export type TtsVoiceDto = z.infer<typeof TtsVoiceSchema>;
export type TtsProviderDto = z.infer<typeof TtsProviderSchema>;
export type ListTtsProvidersResponseDto = z.infer<typeof ListTtsProvidersResponseSchema>;
export type SynthesizeNarrationRequestDto = z.infer<typeof SynthesizeNarrationRequestSchema>;
export type SynthesizeNarrationResponseDto = z.infer<typeof SynthesizeNarrationResponseSchema>;
export type TtsJobInputDto = z.infer<typeof TtsJobInputSchema>;
export type TtsJobResultDto = z.infer<typeof TtsJobResultSchema>;
export type TtsNarrationAssetDto = z.infer<typeof TtsNarrationAssetSchema>;
