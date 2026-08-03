import { ErrorCode, type TtsProviderDto } from "@vidcom/contracts";
import type { TtsSynthesisRequest, TtsWordTiming } from "@vidcom/core";

/**
 * Raw output of one cue, still in whatever container the engine produced.
 *
 * The file must live inside the context's `scratchDir`; the registry owns that
 * directory's lifetime and deletes it whether the batch succeeded or not.
 */
export interface RawCueAudio {
  cueId: string;
  /** Absolute path inside `scratchDir`. Any container FFmpeg can decode is fine. */
  filePath: string;
  /** Empty when the engine reports no alignment. */
  words: readonly TtsWordTiming[];
  /**
   * Whether the engine already applied `ratePercent` itself. ElevenLabs takes a
   * speed parameter, so re-applying `atempo` afterwards would compound the two
   * and produce audio at roughly the square of the requested rate.
   */
  rateApplied: boolean;
  /** Provenance recorded in the narration sidecar: model, effective device, output format. */
  metadata: Record<string, string | number | boolean>;
}

/** Scratch space and cancellation handed to a provider for one batch. */
export interface TtsProviderContext {
  /** Exists and is empty when synthesis begins; the provider may create files freely inside it. */
  scratchDir: string;
  signal?: AbortSignal;
  /** Called with a 1-based count as each cue finishes. */
  onCueDone?(done: number, total: number): void;
}

/**
 * What a TTS engine must provide to plug into VidCom.
 *
 * Deliberately narrow. A provider produces audio files and says what it can do;
 * everything shared — text preparation, voice validation, WAV normalization,
 * duration probing, scratch cleanup, error mapping — belongs to the registry, so
 * adding a third engine cannot quietly introduce a third audio format or a
 * second way of reporting failure.
 */
export interface TtsProviderAdapter {
  readonly id: string;

  /**
   * This provider's static voice catalog plus whatever runtime facts change what
   * it can do right now: a missing API key, an uninstalled sidecar, and — for
   * local engines — whether a usable GPU exists. `computeDevices` MUST list
   * `"cpu"` and MUST include `"gpu"` only after the provider has confirmed a
   * working device, never because a driver appears to be installed.
   *
   * Called rarely and cached by the registry, so probing a sidecar here is fine;
   * network calls are not.
   */
  describe(): Promise<TtsProviderDto>;

  /**
   * Synthesizes the whole batch into `context.scratchDir`.
   *
   * `request.cues` arrive with speech-control cues already resolved for this
   * provider's capabilities. Throws `TtsProviderError` for anything the user can
   * act on; the registry maps it to a domain error.
   */
  synthesize(
    request: TtsSynthesisRequest,
    context: TtsProviderContext,
  ): Promise<readonly RawCueAudio[]>;
}

/** Engine failure carrying the boundary code the user should see. */
export class TtsProviderError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = ErrorCode.TtsSynthesisFailed,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TtsProviderError";
  }
}

/**
 * Rejects a cue id that could escape the scratch directory or collide with the
 * provider's own bookkeeping files.
 *
 * Cue ids are scene ids, which come from author-written `data-composition-id`
 * attributes — untrusted enough that they must never be interpolated into a
 * path unchecked.
 */
export function assertSafeCueId(cueId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(cueId)) {
    throw new TtsProviderError(
      `scene id "${cueId}" cannot be used as an audio filename — use letters, digits, hyphen and underscore`,
      ErrorCode.SchemaInvalid,
    );
  }
}
