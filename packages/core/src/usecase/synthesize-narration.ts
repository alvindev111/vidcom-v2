import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
  type TtsComputeDeviceDto,
  type TtsNarrationAssetDto,
} from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import {
  checkWordTimings,
  resolveWordTimings,
  type ResolvedWordTimings,
  type WordTimingSource,
} from "../domain/word-timings";
import { err, ok, type Result } from "../error/result";
import type { CompositeStep } from "../port/types";
import type { SynthesizedCue, TtsPort, TtsSynthesisOptions, TtsWordTiming } from "../port/tts-port";
import type { ProjectWriteDependencies } from "./project-writes";

export interface SynthesizeNarrationDependencies extends ProjectWriteDependencies {
  tts: TtsPort;
}

export interface SynthesizeNarrationInput {
  projectId: ProjectId;
  sceneIds: readonly string[];
  providerId: string;
  voiceId: string;
  modelId: string | null;
  ratePercent: number;
  computeDevice: TtsComputeDeviceDto;
}

export interface SynthesizeNarrationOutput {
  assets: TtsNarrationAssetDto[];
  revision: number;
}

/** Narration sidecar written next to the audio; mirrors what `regenerateNarration` produces for mock records. */
interface GeneratedNarrationRecord {
  sceneId: string;
  text: string;
  voice: string;
  status: "generated";
  audioPath: string;
  command: string;
  revision: number;
  updatedAt: string;
  staleSince: null;
  provider: string;
  durationSeconds: number;
  /**
   * Word boundaries against the published audio, for word-level transcript
   * highlighting. Always present when the cue has words to speak, whatever the
   * engine reported — see `wordTimingSource` for how they were arrived at.
   */
  words?: readonly TtsWordTiming[];
  /** `engine` = measured against the audio; `estimated` = apportioned from the text. */
  wordTimingSource?: WordTimingSource;
  /** Engine provenance: model, revision, device, effective rate. */
  engine: Record<string, string | number | boolean>;
}

/**
 * Generates real narration audio for the named scenes and publishes it into the project.
 *
 * Reads each scene's narration text from its existing sidecar, so a scene whose
 * narration was never authored is rejected rather than voiced as silence.
 * Nothing is written until every cue has been synthesized: the whole batch lands
 * as one composite mutation, one revision and one `project.changed` event, so a
 * provider that dies on cue four cannot leave three scenes voiced with the new
 * engine and the rest on the old one.
 *
 * Writes `narration/<sceneId>.wav` and rewrites `narration/<sceneId>.json` with
 * `status: "generated"`, the engine that produced it and the measured duration.
 * Marks nothing stale — this call is what clears staleness.
 *
 * Runs the TTS engine, which is network and/or subprocess I/O measured in tens
 * of seconds. Intended to be called from the `tts` job, not from a request handler.
 *
 * Aborting `options.signal` stops the engine and, up to the moment the write
 * begins, guarantees nothing is published — so a cancelled job cannot leave
 * audio behind. It throws rather than returning a `Result`: cancellation is the
 * caller's own instruction coming back, not a failure of this operation.
 */
export async function synthesizeNarration(
  dependencies: SynthesizeNarrationDependencies,
  input: SynthesizeNarrationInput,
  actor: Actor,
  options: TtsSynthesisOptions = {},
): Promise<Result<SynthesizeNarrationOutput, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });

  const cues = await collectCues(dependencies, ref, input.sceneIds);
  if (!cues.ok) return cues;

  const synthesized = await dependencies.tts.synthesize({
    cues: cues.value.map((cue) => ({ id: cue.sceneId, text: cue.text })),
    providerId: input.providerId,
    voiceId: input.voiceId,
    modelId: input.modelId,
    languageCode: cues.value[0]?.languageCode ?? "vi",
    ratePercent: input.ratePercent,
    computeDevice: input.computeDevice,
  }, options);
  if (!synthesized.ok) return synthesized;

  const audioByScene = new Map(synthesized.value.map((cue) => [cue.cueId, cue]));
  const steps: CompositeStep[] = [];
  const assets: TtsNarrationAssetDto[] = [];
  const updatedAt = dependencies.clock.now().toISOString();
  for (const cue of cues.value) {
    const audio = audioByScene.get(cue.sceneId);
    if (!audio) {
      return err({
        code: ErrorCode.TtsSynthesisFailed,
        message: `the ${input.providerId} engine returned no audio for scene ${cue.sceneId}`,
        details: { sceneId: cue.sceneId },
      });
    }
    const timings = resolveWordTimings({
      engineWords: audio.words,
      text: cue.text,
      durationSeconds: audio.durationSeconds,
    });
    const checked = checkWordTimings(timings.words, audio.durationSeconds);
    if (!checked.ok) return err({ ...checked.error, details: { sceneId: cue.sceneId } });
    const record = buildRecord(cue, audio, timings, input, updatedAt);
    steps.push(
      {
        kind: "write",
        path: cue.audioPath,
        content: audio.audio,
        expectedContentHash: cue.audioHash,
      },
      {
        kind: "write",
        path: cue.sidecarPath,
        content: `${JSON.stringify(record, null, 2)}\n`,
        expectedContentHash: cue.sidecarHash,
      },
    );
    assets.push({
      sceneId: cue.sceneId,
      path: record.audioPath,
      durationSeconds: record.durationSeconds,
    });
  }

  // Last gate before the write: a batch cancelled while the engine was running
  // must not land on disk. Once `mutateSource` starts it is the write
  // authority's transaction and cancelling it is no longer this function's call.
  options.signal?.throwIfAborted();
  const written = await dependencies.authority.mutateSource({
    ref,
    steps,
    toolAudit: null,
    backup: false,
  }, actor);
  return written.ok ? ok({ assets, revision: written.value.projectRevision }) : written;
}

/** Everything one scene contributes to the batch, gathered before the engine runs. */
interface NarrationCue {
  sceneId: string;
  text: string;
  languageCode: string;
  audioPath: RelPath;
  audioHash: ContentHash | null;
  sidecarPath: RelPath;
  sidecarHash: ContentHash | null;
  previousRevision: number;
}

async function collectCues(
  dependencies: SynthesizeNarrationDependencies,
  ref: ProjectRef,
  sceneIds: readonly string[],
): Promise<Result<NarrationCue[], DomainError>> {
  const duplicate = sceneIds.find((id, index) => sceneIds.indexOf(id) !== index);
  if (duplicate !== undefined) {
    return err({
      code: ErrorCode.DuplicateMutationTarget,
      message: `scene ${duplicate} appears twice in the same narration batch`,
      field: "sceneIds",
    });
  }
  const model = await dependencies.composition.parseProject(ref);
  const scenes = new Map(model.scenes.map((scene) => [scene.id, scene]));
  const cues: NarrationCue[] = [];
  for (const sceneId of sceneIds) {
    const scene = scenes.get(sceneId);
    if (!scene) {
      return err({ code: ErrorCode.SceneNotFound, message: `scene ${sceneId} is not in this project`, field: "sceneIds" });
    }
    const text = scene.narration?.text.trim() ?? "";
    if (!text) {
      return err({
        code: ErrorCode.NotFound,
        message: `scene ${sceneId} has no narration text — write the narration before generating audio`,
        field: "sceneIds",
      });
    }
    const audioPath = `narration/${sceneId}.wav` as RelPath;
    const sidecarPath = `narration/${sceneId}.json` as RelPath;
    const [audioTarget, sidecarTarget] = await Promise.all([
      dependencies.workspace.resolve(ref, audioPath, "write-asset"),
      dependencies.workspace.resolve(ref, sidecarPath, "system-write"),
    ]);
    if (!audioTarget.ok || !sidecarTarget.ok) {
      return err({ code: ErrorCode.PathOutsideProject, message: `the narration path for scene ${sceneId} was rejected` });
    }
    const [audioHash, sidecarHash] = await Promise.all([
      dependencies.workspace.readHash(audioTarget.value),
      dependencies.workspace.readHash(sidecarTarget.value),
    ]);
    cues.push({
      sceneId,
      text,
      // ISO 639-1 for Vietnamese: these are Vietnamese-first engines and the
      // project model carries no locale yet. Revisit when projects gain one.
      languageCode: "vi",
      audioPath,
      audioHash,
      sidecarPath,
      sidecarHash,
      previousRevision: scene.narration?.revision ?? 0,
    });
  }
  return ok(cues);
}

function buildRecord(
  cue: NarrationCue,
  audio: SynthesizedCue,
  timings: ResolvedWordTimings,
  input: SynthesizeNarrationInput,
  updatedAt: string,
): GeneratedNarrationRecord {
  return {
    sceneId: cue.sceneId,
    text: cue.text,
    voice: input.voiceId,
    status: "generated",
    audioPath: cue.audioPath,
    command: `vidcom tts --scene ${cue.sceneId} --provider ${input.providerId} --voice ${input.voiceId} --rate ${input.ratePercent}`,
    revision: cue.previousRevision + 1,
    updatedAt,
    staleSince: null,
    provider: input.providerId,
    durationSeconds: audio.durationSeconds,
    ...(timings.words.length > 0
      ? { words: timings.words, wordTimingSource: timings.source }
      : {}),
    engine: audio.metadata,
  };
}
