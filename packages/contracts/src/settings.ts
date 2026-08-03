import { z } from "zod";

import { DEFAULT_TTS_COMPUTE_DEVICE, MAX_TTS_RATE_PERCENT, MIN_TTS_RATE_PERCENT, TtsComputeDeviceSchema } from "./tts";

const optionalPath = z.string().min(1).nullish();

/** ElevenLabs account settings; the key is the only secret this file holds. */
const ElevenLabsSettingsSchema = z.strictObject({
  /**
   * Plaintext, because the API needs it verbatim — there is no hash that would
   * still authenticate. `ELEVENLABS_API_KEY` overrides it, so CI and one-off runs
   * never have to write it down.
   */
  apiKey: z.string().min(1).nullish(),
});

const VieNeuSettingsSchema = z.strictObject({
  /** Interpreter and script, e.g. `["/path/.venv/bin/python", "/path/worker.py"]`. */
  command: z.array(z.string().min(1)).min(1).nullish(),
  /**
   * Hugging Face revision to pin the weights to. Unpinned, the sidecar reports
   * whichever commit it resolved so a WAV stays traceable.
   */
  modelRevision: z.string().min(1).nullish(),
});

const TtsSettingsSchema = z.strictObject({
  /** Provider preselected in the UI; must be one `list_tts_voices` reports. */
  defaultProviderId: z.string().min(1).nullish(),
  defaultVoiceId: z.string().min(1).nullish(),
  defaultRatePercent: z.number().int().min(MIN_TTS_RATE_PERCENT).max(MAX_TTS_RATE_PERCENT).nullish(),
  /** No `auto`: GPU stays an explicit choice even as a saved default. */
  defaultComputeDevice: TtsComputeDeviceSchema.nullish(),
  elevenlabs: ElevenLabsSettingsSchema.nullish(),
  vieneu: VieNeuSettingsSchema.nullish(),
});

/**
 * Everything `~/.vidcom/setting.json` may declare.
 *
 * Strict on purpose: a mistyped key is a setting that silently does nothing,
 * which is worse than a startup error naming the line to fix. Every field is
 * optional — an empty `{}` is valid and means "all defaults".
 */
export const VidcomSettingsSchema = z.strictObject({
  /** Ignored by VidCom; present so editors can offer completion. */
  $schema: z.string().nullish(),
  /**
   * Where the database, model cache and backups live. Defaults to the
   * platform's application-data directory; `VIDCOM_APP_DATA` overrides both.
   */
  appDataRoot: optionalPath,
  /** Workspace opened when none is passed and none was last used. */
  workspaceRoot: optionalPath,
  tts: TtsSettingsSchema.nullish(),
});

export type VidcomSettingsDto = z.infer<typeof VidcomSettingsSchema>;

/** Settings with every optional level filled in, so callers never walk nullables. */
export interface ResolvedVidcomSettings {
  appDataRoot: string | null;
  workspaceRoot: string | null;
  tts: {
    defaultProviderId: string | null;
    defaultVoiceId: string | null;
    defaultRatePercent: number;
    defaultComputeDevice: z.infer<typeof TtsComputeDeviceSchema>;
    elevenlabs: { apiKey: string | null };
    vieneu: { command: readonly string[] | null; modelRevision: string | null };
  };
}

/** The behaviour of a machine with no settings file at all. */
export const DEFAULT_VIDCOM_SETTINGS: ResolvedVidcomSettings = {
  appDataRoot: null,
  workspaceRoot: null,
  tts: {
    defaultProviderId: null,
    defaultVoiceId: null,
    defaultRatePercent: 0,
    defaultComputeDevice: DEFAULT_TTS_COMPUTE_DEVICE,
    elevenlabs: { apiKey: null },
    vieneu: { command: null, modelRevision: null },
  },
};

/** Fills every gap in a parsed settings document from `DEFAULT_VIDCOM_SETTINGS`. */
export function resolveVidcomSettings(document: VidcomSettingsDto): ResolvedVidcomSettings {
  const tts = document.tts ?? {};
  return {
    appDataRoot: document.appDataRoot ?? null,
    workspaceRoot: document.workspaceRoot ?? null,
    tts: {
      defaultProviderId: tts.defaultProviderId ?? null,
      defaultVoiceId: tts.defaultVoiceId ?? null,
      defaultRatePercent: tts.defaultRatePercent ?? DEFAULT_VIDCOM_SETTINGS.tts.defaultRatePercent,
      defaultComputeDevice: tts.defaultComputeDevice ?? DEFAULT_TTS_COMPUTE_DEVICE,
      elevenlabs: { apiKey: tts.elevenlabs?.apiKey ?? null },
      vieneu: {
        command: tts.vieneu?.command ?? null,
        modelRevision: tts.vieneu?.modelRevision ?? null,
      },
    },
  };
}
