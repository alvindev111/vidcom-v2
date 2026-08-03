import type { DomainError, TtsComputeDeviceDto, TtsProviderDto } from "@vidcom/contracts";

import type { Result } from "../error/result";

/** One unit of speech to synthesize; `id` is the scene the audio belongs to. */
export interface TtsCue {
  id: string;
  text: string;
}

/** Word boundary inside a synthesized cue, relative to the start of that cue's audio. */
export interface TtsWordTiming {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

/** A complete synthesis batch: one provider, one voice, many cues. */
export interface TtsSynthesisRequest {
  cues: readonly TtsCue[];
  providerId: string;
  voiceId: string;
  /** `null` lets the provider pick its default model for that voice. */
  modelId: string | null;
  /** ISO 639-1 code handed to engines that accept one; local engines ignore it. */
  languageCode: string;
  ratePercent: number;
  /**
   * Rejected with `tts_provider_unavailable` when the provider has not
   * advertised this device — asking for `gpu` on a machine without a usable one
   * fails loudly instead of quietly running on CPU at a tenth of the speed.
   */
  computeDevice: TtsComputeDeviceDto;
}

/** Finished audio for one cue, already normalized to the format the composition schedule expects. */
export interface SynthesizedCue {
  cueId: string;
  /** WAV, 44.1 kHz, mono — identical across providers so downstream code never branches on engine. */
  audio: Uint8Array;
  durationSeconds: number;
  /**
   * Empty when the engine reports no alignment. VieNeu has none at all, so an
   * optional field would push an `undefined` check onto every caller for a case
   * that is simply "this engine does not know".
   */
  words: readonly TtsWordTiming[];
  /** Engine-reported provenance recorded in the narration sidecar: model, device, effective rate. */
  metadata: Record<string, string | number | boolean>;
}

/** Progress and cancellation hooks for a batch that can run for minutes. */
export interface TtsSynthesisOptions {
  signal?: AbortSignal;
  /** Called once per finished cue with a 1-based index; must not throw. */
  onCueDone?(done: number, total: number): void;
}

/** Text-to-speech engines available to this runtime, behind one contract. */
export interface TtsPort {
  /**
   * Every registered provider with its voice catalog, including providers that
   * cannot run right now — those carry `available: false` and a reason, because
   * a missing API key should read as "add your key", not as a vanished feature.
   *
   * Catalogs are static per provider; this performs no network I/O, though it
   * may stat the filesystem to check a sidecar is installed.
   */
  listProviders(): Promise<TtsProviderDto[]>;

  /**
   * Synthesizes every cue in the batch and returns the audio bytes in request order.
   *
   * Writes only to its own scratch storage — never into a project workspace, so
   * the write authority stays the single path to a user's files. Callers hold
   * the audio in memory: a narration cue is a sentence, not a master track.
   *
   * Runs the engine, which means network I/O, a model sidecar, or both, plus
   * FFmpeg normalization. A provider that cannot run returns an error rather
   * than throwing; throws only on programmer error such as an unknown provider
   * shape reaching the registry.
   */
  synthesize(
    request: TtsSynthesisRequest,
    options?: TtsSynthesisOptions,
  ): Promise<Result<readonly SynthesizedCue[], DomainError>>;
}
