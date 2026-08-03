import {
  ErrorCode,
  type DomainError,
  type ProjectId,
  type TtsComputeDeviceDto,
  type TtsProviderDto,
  type TtsVoiceDto,
} from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import type { TtsPort } from "../port/tts-port";
import type { ProjectReadDependencies } from "./project-reads";

export interface NarrationSynthesisPlanInput {
  projectId: ProjectId;
  sceneIds: readonly string[];
  providerId: string;
  voiceId: string;
  modelId: string | null;
  computeDevice: TtsComputeDeviceDto;
}

export interface NarrationSynthesisPlan {
  /** The catalog entry the request resolved to, including its real model id. */
  voice: TtsVoiceDto;
  /** Scene ids paired with the narration text that will be spoken. */
  cues: readonly { sceneId: string; text: string }[];
}

export interface PlanNarrationSynthesisDependencies {
  tts: TtsPort;
  reads: ProjectReadDependencies;
}

/**
 * Everything that decides whether a synthesis request can succeed, checked
 * without running an engine.
 *
 * Exists so the HTTP and MCP boundaries can reject a bad request with a precise
 * code and field instead of returning `202` for a job that will fail minutes
 * later. Covers the provider being installed and usable, the voice belonging to
 * it, the requested device being one it advertises, every scene existing, and
 * every scene having narration text to speak.
 *
 * Reads the composition through the project cache, so calling it per request is
 * cheap after the first. Performs no writes and starts no job.
 */
export async function planNarrationSynthesis(
  dependencies: PlanNarrationSynthesisDependencies,
  input: NarrationSynthesisPlanInput,
): Promise<Result<NarrationSynthesisPlan, DomainError>> {
  const duplicate = input.sceneIds.find((id, index) => input.sceneIds.indexOf(id) !== index);
  if (duplicate !== undefined) {
    return err({
      code: ErrorCode.DuplicateMutationTarget,
      message: `scene ${duplicate} appears twice in the same narration batch`,
      field: "sceneIds",
    });
  }

  const providers = await dependencies.tts.listProviders();
  const provider = providers.find((candidate) => candidate.id === input.providerId);
  if (!provider) {
    return err({
      code: ErrorCode.TtsProviderUnavailable,
      message: `no TTS engine named "${input.providerId}" is installed in this build`,
      field: "providerId",
    });
  }
  if (!provider.available) {
    return err({
      code: provider.unavailableReason === "credential_missing"
        ? ErrorCode.TtsCredentialMissing
        : ErrorCode.TtsProviderUnavailable,
      message: unavailableMessage(provider.label, provider.unavailableReason),
      ...(provider.unavailableReason === "audio_toolchain_missing" ? {} : { field: "providerId" }),
    });
  }

  const voice = resolveVoice(provider, input.voiceId);
  if (!voice) {
    return err({
      code: ErrorCode.TtsVoiceNotSupported,
      message: `voice "${input.voiceId}" does not belong to the ${provider.label} engine`,
      field: "voiceId",
    });
  }
  if (input.modelId !== null && input.modelId !== voice.modelId) {
    return err({
      code: ErrorCode.TtsVoiceNotSupported,
      message: `voice "${voice.label}" runs on model ${voice.modelId}, not ${input.modelId}`,
      field: "modelId",
    });
  }
  if (!voice.computeDevices.includes(input.computeDevice)) {
    return err({
      code: ErrorCode.TtsProviderUnavailable,
      message: input.computeDevice === "gpu"
        ? `GPU synthesis was requested but ${provider.label} found no usable GPU on this machine — leave the device on CPU`
        : `${provider.label} cannot run on ${input.computeDevice} here`,
      field: "computeDevice",
    });
  }

  const ref = await dependencies.reads.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const model = dependencies.reads.cache
    ? await dependencies.reads.cache.get(ref.id, () => dependencies.reads.composition.parseProject(ref))
    : await dependencies.reads.composition.parseProject(ref);
  const scenes = new Map(model.scenes.map((scene) => [scene.id, scene]));

  const cues: { sceneId: string; text: string }[] = [];
  for (const sceneId of input.sceneIds) {
    const scene = scenes.get(sceneId);
    if (!scene) {
      return err({
        code: ErrorCode.SceneNotFound,
        message: `scene ${sceneId} is not in this project`,
        field: "sceneIds",
      });
    }
    const text = scene.narration?.text.trim() ?? "";
    if (!text) {
      return err({
        code: ErrorCode.NotFound,
        message: `scene ${sceneId} has no narration text — write the narration before generating audio`,
        field: "sceneIds",
      });
    }
    cues.push({ sceneId, text });
  }
  return ok({ voice, cues });
}

/**
 * The catalog entry for a voice id, synthesised from the provider defaults when
 * the id is unlisted but the provider accepts custom ones.
 *
 * ElevenLabs accounts hold cloned voices no shipped catalog can list; refusing
 * every id we do not recognise would lock those users out of the only voice they
 * care about. `null` means the id is genuinely not usable here.
 */
export function resolveVoice(provider: TtsProviderDto, voiceId: string): TtsVoiceDto | null {
  const listed = provider.voices.find((candidate) => candidate.id === voiceId);
  if (listed) return listed;
  const defaults = provider.customVoiceDefaults;
  if (!provider.allowsCustomVoiceId || !defaults || !/^[A-Za-z0-9_-]{1,255}$/.test(voiceId)) return null;
  // Unrecommended by construction: a cloned voice is one VidCom has never heard.
  return { id: voiceId, providerId: provider.id, label: voiceId, language: "vi", recommended: false, ...defaults };
}

/** Turns an unavailability reason into the one action the user has to take. */
export function unavailableMessage(label: string, reason: string | null): string {
  switch (reason) {
    case "credential_missing":
      return `${label} needs an API key before it can generate narration`;
    case "sidecar_missing":
      return `${label} needs its local speech sidecar installed before it can generate narration`;
    case "audio_toolchain_missing":
      return `${label} needs FFmpeg on PATH before it can generate narration`;
    default:
      return `${label} is not available on this machine`;
  }
}
