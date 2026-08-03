import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { ErrorCode, type TtsComputeDeviceDto, type TtsProviderDto, type TtsVoiceDto } from "@vidcom/contracts";
import type { ProcessPort, TtsSynthesisRequest } from "@vidcom/core";

import {
  TtsProviderError,
  type RawCueAudio,
  type TtsProviderAdapter,
  type TtsProviderContext,
} from "./tts-provider";

const PROVIDER_ID = "vieneu";
const MODEL_ID = "vieneu-v3-turbo";

/** 20 minutes: the first run may still be fetching weights before it speaks a word. */
const SYNTHESIS_TIMEOUT_MS = 20 * 60 * 1_000;

/**
 * 10 minutes. Upstream exposes its voice list only as an instance method, so the
 * probe has to build the engine, and on a cold machine that pulls the model.
 * The registry caches the result for the process lifetime, so a run pays this
 * at most once — but a 2-minute ceiling turned a first launch on a slow link
 * into a permanently "missing" sidecar.
 */
const PROBE_TIMEOUT_MS = 10 * 60 * 1_000;

/** Two attempts, because the failure this covers is a truncated model download, not a bad request. */
const MAX_ATTEMPTS = 2;

/** Raw sidecar output must at least carry a WAV header and a sample or two. */
const MINIMUM_RAW_BYTES = 256;

/**
 * The four v3 Turbo presets VidCom puts forward for Vietnamese narration.
 *
 * A shortlist over the engine's full preset set, so the first narration is one
 * choice rather than a survey. Matched against what the probe actually reported:
 * an id here that the installed engine does not offer is simply absent from the
 * catalog, never conjured into it — the engine's own list stays authoritative.
 */
const RECOMMENDED_VOICE_IDS: ReadonlySet<string> = new Set([
  "vieneu-v3-doan-trang",
  "vieneu-v3-minh-duc",
  "vieneu-v3-ngoc-linh",
  "vieneu-v3-pham-tuyen",
]);

/**
 * Stable VidCom id for an engine speaker name.
 *
 * The engine addresses voices by their Vietnamese display name ("Phạm Tuyên"),
 * which is not safe to put in a URL or a settings file. The id is derived, not
 * invented, so a voice upstream adds appears without a VidCom release — and a
 * name VidCom offers can never be one the engine rejects.
 */
function voiceIdFor(engineName: string): string {
  const slug = engineName
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/đ/gu, "d")
    .replace(/Đ/gu, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `vieneu-v3-${slug}`;
}

export interface VieNeuTtsProviderOptions {
  processes: ProcessPort;
  /**
   * Interpreter and script, e.g. `["python", "<sidecars>/vieneu/worker.py"]`.
   *
   * A thunk, not a value: the command lives in app settings, and the settings
   * table does not exist yet when the composition root builds this provider —
   * reading it eagerly crashed startup before the migration had run.
   */
  command: () => readonly string[];
  /**
   * Absolute app-data directory the sidecar downloads weights into, passed as
   * `HF_HOME`. Must sit outside both the source tree and any workspace: the v3
   * Turbo checkpoint is several gigabytes, and a relative or unset cache lands
   * it wherever the process started — inside a checkout, inside a user's
   * project, inside whatever the next backup picks up.
   */
  modelCacheRoot: string;
  /**
   * Hugging Face revision to pin the weights to, from `~/.vidcom/setting.json`.
   *
   * `null` lets the sidecar take the repository's current head and report which
   * commit that was, so a WAV stays traceable even unpinned. Pin it to make
   * narration reproducible across machines and across upstream releases.
   */
  modelRevision?: string | null;
}

interface WorkerResponse {
  schemaVersion: 1;
  provider: "vieneu";
  modelId: string;
  /** Commit the weights were resolved to, so a WAV is traceable to what produced it. */
  modelRevision: string;
  effectiveDevice: TtsComputeDeviceDto;
  assets: { cueId: string; path: string }[];
}

interface ProbeResponse {
  schemaVersion: 1;
  /** Whether the engine imported and offered at least one voice. */
  ready: boolean;
  /** True only when the sidecar successfully allocated on a GPU, not when a driver merely exists. */
  gpu: boolean;
  /** Preset speaker names straight from the engine; VidCom keeps no copy of its own. */
  voices: string[];
  engineVersion: string;
}

/**
 * VieNeu-TTS v3 Turbo through a local Python sidecar.
 *
 * One sidecar invocation loads the model once and speaks the whole batch —
 * per-cue invocations paid the multi-second load for every sentence. The
 * request and response travel as JSON files rather than stdio because `vidcom
 * mcp` shares this process's stdout with the MCP transport, and one stray print
 * from a Python dependency would corrupt the protocol stream.
 *
 * Runs on CPU unless a probe has confirmed the sidecar can actually allocate on
 * a GPU. `describe()` advertises `gpu` only after that probe succeeds, so
 * nothing can select it on a machine that would then fall back silently.
 */
export class VieNeuTtsProvider implements TtsProviderAdapter {
  readonly id = PROVIDER_ID;

  /**
   * VidCom voice id to the engine's own speaker name, filled by `describe()`.
   *
   * Empty until then, which is safe: the registry always describes a provider
   * before it routes a batch to it, and synthesizing against an empty map
   * rejects the voice rather than guessing a speaker.
   */
  #engineVoices: ReadonlyMap<string, string> = new Map();

  constructor(private readonly options: VieNeuTtsProviderOptions) {
    if (!isAbsolute(options.modelCacheRoot)) {
      throw new TypeError("VieNeu model cache root must be an absolute app-data path");
    }
  }

  /** The configured invocation, rejected here rather than spawned as an empty command. */
  private command(): readonly string[] {
    const command = this.options.command();
    if (!command.length || command.some((part) => !part.trim())) {
      throw new TtsProviderError(
        "the VieNeu sidecar command is not configured — set tts.vieneu.command to your interpreter and worker.py",
        ErrorCode.TtsProviderUnavailable,
      );
    }
    return command;
  }

  async describe(): Promise<TtsProviderDto> {
    const probe = await this.probe();
    this.#engineVoices = new Map((probe?.voices ?? []).map((name) => [voiceIdFor(name), name]));
    const computeDevices: TtsComputeDeviceDto[] = probe?.gpu ? ["cpu", "gpu"] : ["cpu"];
    return {
      id: PROVIDER_ID,
      label: "VieNeu-TTS v3 Turbo",
      available: probe?.ready === true,
      unavailableReason: probe?.ready === true ? null : "sidecar_missing",
      // Recommended first, then the engine's own order. A picker that renders the
      // list as given then shows the shortlist at the top without needing to know
      // the flag exists.
      voices: [...this.#engineVoices]
        .map(([id, label]): TtsVoiceDto => ({
          id,
          providerId: PROVIDER_ID,
          label,
          language: "vi",
          modelId: MODEL_ID,
          supportsEmotionCues: true,
          computeDevices,
          recommended: RECOMMENDED_VOICE_IDS.has(id),
        }))
        .sort((left, right) => Number(right.recommended) - Number(left.recommended)),
      // The installed model has exactly the speakers the probe reported; an
      // arbitrary id is a typo, not a cloned voice.
      allowsCustomVoiceId: false,
      customVoiceDefaults: null,
    };
  }

  async synthesize(
    request: TtsSynthesisRequest,
    context: TtsProviderContext,
  ): Promise<readonly RawCueAudio[]> {
    const engineVoice = this.#engineVoices.get(request.voiceId);
    if (!engineVoice) {
      throw new TtsProviderError(
        `VieNeu has no voice called "${request.voiceId}"`,
        ErrorCode.TtsVoiceNotSupported,
      );
    }
    await mkdir(this.options.modelCacheRoot, { recursive: true });
    const requestPath = join(context.scratchDir, "vieneu-request.json");
    const responsePath = join(context.scratchDir, "vieneu-response.json");
    await writeFile(requestPath, JSON.stringify({
      schemaVersion: 1,
      modelId: MODEL_ID,
      device: request.computeDevice,
      voice: engineVoice,
      outputDir: context.scratchDir,
      cues: request.cues.map((cue) => ({ id: cue.id, text: cue.text })),
    }), "utf8");

    const response = await this.runWithRetry(requestPath, responsePath, request.computeDevice, context.signal);
    const reported = new Map(response.assets.map((asset) => [asset.cueId, asset.path]));
    const produced: RawCueAudio[] = [];
    for (const [index, cue] of request.cues.entries()) {
      context.signal?.throwIfAborted();
      const expected = join(context.scratchDir, `${cue.id}.vieneu.wav`);
      if (reported.get(cue.id) !== expected) {
        throw new TtsProviderError(`the VieNeu sidecar reported an unexpected file for scene ${cue.id}`);
      }
      const written = await stat(expected).catch(() => null);
      if (!written?.isFile() || written.size < MINIMUM_RAW_BYTES) {
        throw new TtsProviderError(`the VieNeu sidecar produced no audio for scene ${cue.id}`);
      }
      produced.push({
        cueId: cue.id,
        filePath: expected,
        // VieNeu has no alignment output; captions fall back to cue level.
        words: [],
        rateApplied: false,
        metadata: {
          modelId: response.modelId,
          modelRevision: response.modelRevision,
          effectiveDevice: response.effectiveDevice,
          engineVoice,
        },
      });
      context.onCueDone?.(index + 1, request.cues.length);
    }
    return produced;
  }

  /**
   * Sidecar readiness, or `null` when it could not be started at all.
   *
   * Cached by the registry, not here — a probe that ran before the user
   * installed the sidecar should not be the answer forever within one process,
   * but re-probing on every catalog read would spawn Python per keystroke.
   */
  private async probe(): Promise<ProbeResponse | null> {
    try {
      const output = await this.options.processes.run({
        command: [...this.command(), "--probe"],
        environment: this.environment(),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (output.exitCode !== 0) return null;
      const parsed = JSON.parse(output.stdout) as Partial<ProbeResponse>;
      if (parsed.schemaVersion !== 1) return null;
      const voices = Array.isArray(parsed.voices)
        ? parsed.voices.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
        : [];
      return {
        schemaVersion: 1,
        // A sidecar that imports but offers no voice cannot synthesize anything,
        // so it is not "ready" however cleanly the import went.
        ready: parsed.ready === true && voices.length > 0,
        gpu: parsed.gpu === true,
        voices,
        engineVersion: typeof parsed.engineVersion === "string" ? parsed.engineVersion : "",
      };
    } catch {
      // A missing interpreter, a missing script or unparseable output all mean
      // the same thing to a user: the sidecar is not installed yet.
      return null;
    }
  }

  private async runWithRetry(
    requestPath: string,
    responsePath: string,
    device: TtsComputeDeviceDto,
    signal?: AbortSignal,
  ): Promise<WorkerResponse> {
    const command = this.command();
    let lastMessage = "the VieNeu sidecar did not produce a response";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const output = await this.options.processes.run({
        command: [...command, "--request", requestPath, "--response", responsePath],
        environment: this.environment(),
        timeoutMs: SYNTHESIS_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      }).catch((error: unknown) => {
        lastMessage = error instanceof Error ? error.message : lastMessage;
        return null;
      });
      if (output?.timedOut) {
        lastMessage = "the VieNeu sidecar timed out";
        continue;
      }
      if (output && output.exitCode !== 0) {
        lastMessage = output.stderr.trim() || `the VieNeu sidecar exited with code ${output.exitCode}`;
        continue;
      }
      if (!output) continue;
      try {
        return parseWorkerResponse(await readFile(responsePath, "utf8"), device);
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : lastMessage;
      }
    }
    throw new TtsProviderError(`VieNeu narration failed: ${lastMessage}`);
  }

  private environment(): Record<string, string> {
    return {
      HF_HOME: this.options.modelCacheRoot,
      HF_HUB_CACHE: join(this.options.modelCacheRoot, "hub"),
      TORCH_HOME: join(this.options.modelCacheRoot, "torch"),
      HF_HUB_DISABLE_TELEMETRY: "1",
      TOKENIZERS_PARALLELISM: "false",
      ...(this.options.modelRevision ? { VIDCOM_VIENEU_REVISION: this.options.modelRevision } : {}),
    };
  }
}

/** Validates the sidecar response, including that it ran on the device that was asked for. */
function parseWorkerResponse(raw: string, requestedDevice: TtsComputeDeviceDto): WorkerResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new TtsProviderError("the VieNeu sidecar wrote a response that is not JSON"); }
  const value = parsed as Partial<WorkerResponse>;
  if (value.schemaVersion !== 1 || value.provider !== "vieneu" || !Array.isArray(value.assets)) {
    throw new TtsProviderError("the VieNeu sidecar response does not match the expected schema");
  }
  if (value.modelId !== MODEL_ID) {
    throw new TtsProviderError(`the VieNeu sidecar ran model ${String(value.modelId)} instead of ${MODEL_ID}`);
  }
  if (typeof value.modelRevision !== "string" || !value.modelRevision) {
    throw new TtsProviderError("the VieNeu sidecar did not report which model revision it used");
  }
  // A GPU request that quietly ran on CPU is the exact silent fallback the
  // device policy exists to prevent, so it fails rather than returning slow audio.
  if (value.effectiveDevice !== requestedDevice) {
    throw new TtsProviderError(
      `VieNeu was asked to run on ${requestedDevice} but ran on ${String(value.effectiveDevice)}`,
      ErrorCode.TtsProviderUnavailable,
    );
  }
  return value as WorkerResponse;
}
