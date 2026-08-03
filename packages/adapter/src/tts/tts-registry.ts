import { readFile } from "node:fs/promises";

import { ErrorCode, type DomainError, type TtsProviderDto } from "@vidcom/contracts";
import {
  err,
  ok,
  prepareTtsSpeechText,
  resolveVoice,
  unavailableMessage,
  type ProcessPort,
  type Result,
  type SynthesizedCue,
  type TtsPort,
  type TtsSynthesisOptions,
  type TtsSynthesisRequest,
  type TtsWordTiming,
} from "@vidcom/core";

import { audioToolchainAvailable, normalizeCueAudio, NARRATION_SAMPLE_RATE } from "./tts-audio-normalize";
import { assertSafeCueId, TtsProviderError, type TtsProviderAdapter } from "./tts-provider";
import { withTtsScratch } from "./tts-scratch";

export interface TtsRegistryOptions {
  providers: readonly TtsProviderAdapter[];
  processes: ProcessPort;
  /** App-data directory that holds every engine's intermediates; never a project path. */
  scratchRoot: string;
}

/**
 * The single `TtsPort` implementation: routes a batch to one engine and puts
 * everything shared around it.
 *
 * A provider only produces audio files. Voice validation, speech-cue
 * preparation, WAV normalization, duration measurement, scratch cleanup and
 * error mapping happen here, once, so a fourth engine cannot introduce a fourth
 * behaviour for any of them.
 *
 * Batches are serialized per provider. Two VieNeu batches in parallel each load
 * a multi-gigabyte model, which on a laptop means both swap and neither
 * finishes; the scheduler already caps `tts` at one job, and this holds the line
 * for any other caller.
 */
export class TtsRegistry implements TtsPort {
  readonly #providers: ReadonlyMap<string, TtsProviderAdapter>;
  readonly #catalog = new Map<string, Promise<TtsProviderDto>>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #toolchain: Promise<boolean> | null = null;

  constructor(private readonly options: TtsRegistryOptions) {
    const entries = options.providers.map((provider) => [provider.id, provider] as const);
    this.#providers = new Map(entries);
    if (this.#providers.size !== entries.length) {
      throw new TypeError("TTS provider ids must be unique");
    }
  }

  async listProviders(): Promise<TtsProviderDto[]> {
    return Promise.all([...this.#providers.keys()].map((id) => this.describe(id)));
  }

  async synthesize(
    request: TtsSynthesisRequest,
    options: TtsSynthesisOptions = {},
  ): Promise<Result<readonly SynthesizedCue[], DomainError>> {
    const provider = this.#providers.get(request.providerId);
    if (!provider) {
      return err({
        code: ErrorCode.TtsProviderUnavailable,
        message: `no TTS engine named "${request.providerId}" is installed in this build`,
        field: "providerId",
      });
    }
    const prepared = await this.prepare(provider, request);
    if (!prepared.ok) return prepared;

    try {
      return ok(await this.queued(provider.id, () => this.runBatch(provider, prepared.value, options)));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return err(toDomainError(error, provider.id));
    }
  }

  /** Serializes work per provider so a local engine never loads its model twice at once. */
  private async queued<Value>(providerId: string, work: () => Promise<Value>): Promise<Value> {
    const previous = this.#queues.get(providerId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.#queues.set(providerId, current.catch(() => {}));
    return current;
  }

  /**
   * Provider description, computed once per process.
   *
   * Cached because the local providers probe the filesystem and, for GPU, run a
   * sidecar — neither of which should happen on every catalog request. The
   * consequence is that installing FFmpeg or a sidecar while the daemon runs is
   * not picked up until restart; that is the accepted trade for a catalog call
   * that stays cheap enough for the UI to poll.
   */
  private describe(providerId: string): Promise<TtsProviderDto> {
    const cached = this.#catalog.get(providerId);
    if (cached) return cached;
    const provider = this.#providers.get(providerId);
    if (!provider) throw new TypeError(`unknown TTS provider ${providerId}`);
    const described = this.describeWithToolchain(provider).catch((error: unknown) => {
      this.#catalog.delete(providerId);
      throw error;
    });
    this.#catalog.set(providerId, described);
    return described;
  }

  /**
   * A provider's own description, downgraded when FFmpeg is missing.
   *
   * Every engine's output goes through normalization, so no engine can succeed
   * without FFmpeg — reporting `available: true` on a machine that lacks it
   * means a cloud provider takes the user's money for audio that is then
   * discarded a second later. The check belongs here rather than in each
   * provider because the dependency is the registry's, not theirs.
   */
  private async describeWithToolchain(provider: TtsProviderAdapter): Promise<TtsProviderDto> {
    const [described, toolchain] = await Promise.all([provider.describe(), this.toolchain()]);
    if (toolchain || !described.available) return described;
    return { ...described, available: false, unavailableReason: "audio_toolchain_missing" };
  }

  private toolchain(): Promise<boolean> {
    return this.#toolchain ??= audioToolchainAvailable(this.options.processes);
  }

  /** Validates the request against the provider's live catalog and resolves speech cues. */
  private async prepare(
    provider: TtsProviderAdapter,
    request: TtsSynthesisRequest,
  ): Promise<Result<TtsSynthesisRequest, DomainError>> {
    let description: TtsProviderDto;
    try {
      description = await this.describe(provider.id);
    } catch (error) {
      return err(toDomainError(error, provider.id));
    }
    if (!description.available) {
      return err({
        code: description.unavailableReason === "credential_missing"
          ? ErrorCode.TtsCredentialMissing
          : ErrorCode.TtsProviderUnavailable,
        message: unavailableMessage(description.label, description.unavailableReason),
        field: description.unavailableReason === "audio_toolchain_missing" ? undefined : "providerId",
      });
    }
    const voice = resolveVoice(description, request.voiceId);
    if (!voice) {
      return err({
        code: ErrorCode.TtsVoiceNotSupported,
        message: `voice "${request.voiceId}" does not belong to the ${description.label} engine`,
        field: "voiceId",
      });
    }
    if (request.modelId !== null && request.modelId !== voice.modelId) {
      return err({
        code: ErrorCode.TtsVoiceNotSupported,
        message: `voice "${voice.label}" runs on model ${voice.modelId}, not ${request.modelId}`,
        field: "modelId",
      });
    }
    if (!voice.computeDevices.includes(request.computeDevice)) {
      return err({
        code: ErrorCode.TtsProviderUnavailable,
        message: request.computeDevice === "gpu"
          ? `GPU synthesis was requested but ${description.label} found no usable GPU on this machine — leave the device on CPU`
          : `${description.label} cannot run on ${request.computeDevice} here`,
        field: "computeDevice",
      });
    }

    const cues: { id: string; text: string }[] = [];
    for (const cue of request.cues) {
      const speech = prepareTtsSpeechText(cue.text, { supportsEmotionCues: voice.supportsEmotionCues });
      if (!speech.ok) return err({ ...speech.error, details: { ...speech.error.details, sceneId: cue.id } });
      cues.push({ id: cue.id, text: speech.value });
    }
    return ok({ ...request, cues, modelId: voice.modelId });
  }

  private async runBatch(
    provider: TtsProviderAdapter,
    request: TtsSynthesisRequest,
    options: TtsSynthesisOptions,
  ): Promise<readonly SynthesizedCue[]> {
    for (const cue of request.cues) assertSafeCueId(cue.id);
    return withTtsScratch(this.options.scratchRoot, async (scratchDir) => {
      const raw = await provider.synthesize(request, {
        scratchDir,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onCueDone ? { onCueDone: options.onCueDone } : {}),
      });
      const produced = new Map(raw.map((cue) => [cue.cueId, cue]));
      const cues: SynthesizedCue[] = [];
      for (const cue of request.cues) {
        options.signal?.throwIfAborted();
        const audio = produced.get(cue.id);
        if (!audio) throw new TtsProviderError(`the engine skipped scene ${cue.id}`);
        const ratePercent = audio.rateApplied ? 0 : request.ratePercent;
        const normalized = await normalizeCueAudio(this.options.processes, {
          sourcePath: audio.filePath,
          scratchDir,
          cueId: cue.id,
          ratePercent,
          measureTrimStart: audio.words.length > 0,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        cues.push({
          cueId: cue.id,
          audio: await readFile(normalized.path),
          durationSeconds: normalized.durationSeconds,
          words: rebaseWordTimings(audio.words, normalized),
          metadata: {
            ...audio.metadata,
            provider: provider.id,
            voiceId: request.voiceId,
            computeDevice: request.computeDevice,
            requestedRatePercent: request.ratePercent,
            effectiveRatePercent: audio.rateApplied ? request.ratePercent : ratePercent,
            sampleRate: NARRATION_SAMPLE_RATE,
            trimStartSeconds: normalized.trimStartSeconds,
          },
        });
      }
      return cues;
    });
  }
}

/**
 * Engine word timings moved onto the audio VidCom actually publishes.
 *
 * The engine reports timings against its own untrimmed output. Normalization
 * removes the leading silence and may change the tempo, so every timestamp is
 * late by `trimStartSeconds` and then stretched by the tempo ratio. Copying them
 * through unchanged put the first word half a second after the audio it labels.
 *
 * Timings that fall outside the normalized duration are dropped rather than
 * clamped — a caption pinned to the last frame is more obviously wrong than a
 * missing one, and the whole set is discarded if nothing survives.
 */
function rebaseWordTimings(
  words: readonly TtsWordTiming[],
  normalized: { durationSeconds: number; trimStartSeconds: number },
): readonly TtsWordTiming[] {
  if (words.length === 0) return words;
  const sourceSpan = Math.max(...words.map((word) => word.endSeconds)) - normalized.trimStartSeconds;
  // Tempo changes scale the whole track; deriving the ratio from the measured
  // durations covers both atempo and any resampling the filter chain did.
  const scale = sourceSpan > 0 ? Math.min(1, normalized.durationSeconds / sourceSpan) : 1;
  const rebased: TtsWordTiming[] = [];
  for (const word of words) {
    const startSeconds = rounded((word.startSeconds - normalized.trimStartSeconds) * scale);
    const endSeconds = rounded((word.endSeconds - normalized.trimStartSeconds) * scale);
    if (endSeconds <= 0 || startSeconds >= normalized.durationSeconds) continue;
    rebased.push({
      text: word.text,
      startSeconds: Math.max(0, startSeconds),
      endSeconds: Math.min(normalized.durationSeconds, endSeconds),
    });
  }
  return rebased;
}

function rounded(seconds: number): number {
  return Math.round(seconds * 1_000) / 1_000;
}

function toDomainError(error: unknown, providerId: string): DomainError {
  if (error instanceof TtsProviderError) {
    return { code: error.code, message: error.message, details: { providerId } };
  }
  return {
    code: ErrorCode.TtsSynthesisFailed,
    message: `the ${providerId} engine failed while generating narration`,
    details: { providerId },
  };
}
