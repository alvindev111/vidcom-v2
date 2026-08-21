import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { planCaptionCues, type CaptionCue } from "../domain/plan-caption-cues";
import type { WordTimingSource } from "../domain/word-timings";
import { err, ok, type Result } from "../error/result";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { CompositionPort, WorkspacePort } from "../port/ports";
import type { WriteInvocation } from "../port/types";
import type { MutationRequest, WriteResult } from "../service/write-authority";
import { readCues } from "./narration-cues";

export interface GenerateCaptionsDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readFile">;
  composition: Pick<CompositionPort, "parseProject" | "applyOps">;
  authority: {
    mutateSource(
      request: MutationRequest,
      actor: Actor,
      invocation?: WriteInvocation,
    ): Promise<Result<WriteResult, DomainError>>;
  };
}

export interface GenerateCaptionsOutput {
  cues: CaptionCue[];
  timingSource: WordTimingSource;
  envelope: {
    projectRevision: number;
    entityRevision: null;
    fileHashes: Record<RelPath, ContentHash>;
    diagnostics: WriteResult["diagnostics"];
    changeSeq: number | null;
  };
}

/** Plans current narration timings and atomically replaces one scene's authored caption track. */
export async function generateCaptions(
  dependencies: GenerateCaptionsDependencies,
  input: { projectId: ProjectId; sceneId: string; expectedContentHash: ContentHash },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
): Promise<Result<GenerateCaptionsOutput, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });

  let model: Awaited<ReturnType<CompositionPort["parseProject"]>>;
  try { model = await dependencies.composition.parseProject(ref); }
  catch {
    return err({ code: ErrorCode.ProjectInvalid, message: "project composition is invalid" });
  }
  const scene = model.scenes.find((candidate) => candidate.id === input.sceneId);
  if (!scene) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found" });

  const narrationPath = `narration/${scene.id}.json` as RelPath;
  const narrationTarget = await dependencies.workspace.resolve(ref, narrationPath, "system-write");
  if (!narrationTarget.ok) {
    return err({ code: ErrorCode.PathOutsideProject, message: "narration path was rejected" });
  }
  const sidecar = await dependencies.workspace.readFile(narrationTarget.value);
  if (!sidecar) return noNarration(scene.id);
  let raw: unknown;
  try { raw = JSON.parse(sidecar.content); }
  catch { return noNarration(scene.id); }
  const narrationCues = readCues(raw);
  if (narrationCues.length === 0 || narrationCues.some((cue) =>
    !cue.words?.length || (cue.wordTimingSource !== "engine" && cue.wordTimingSource !== "estimated"))) {
    return noNarration(scene.id);
  }

  let cues: CaptionCue[];
  try {
    cues = planCaptionCues(narrationCues.map((cue) => ({
      start: cue.offsetSeconds,
      words: cue.words!,
    })), scene.duration);
  } catch {
    return err({
      code: ErrorCode.InvariantViolated,
      message: `scene ${scene.id} narration timings cannot produce non-overlapping captions`,
    });
  }
  if (cues.length === 0) return noNarration(scene.id);
  const timingSource: WordTimingSource = narrationCues.some((cue) => cue.wordTimingSource === "estimated")
    ? "estimated"
    : "engine";
  const sourcePath = scene.src && model.sources.some((source) => source.path === scene.src)
    ? scene.src as RelPath
    : ref.entry;
  const applied = await dependencies.composition.applyOps(ref, sourcePath, [{
    kind: "replaceCaptions",
    target: scene.id,
    value: { cues, timingSource },
  }]);
  if (!applied.ok) return applied;
  const written = await dependencies.authority.mutateSource({
    kind: "file",
    ref,
    path: sourcePath,
    content: applied.value,
    expectedContentHash: input.expectedContentHash,
  }, actor, invocation);
  if (!written.ok) return written;
  return ok({
    cues,
    timingSource,
    envelope: {
      projectRevision: written.value.revision,
      entityRevision: null,
      fileHashes: { [sourcePath]: written.value.contentHash },
      diagnostics: written.value.diagnostics,
      changeSeq: written.value.changeSeq ?? null,
    },
  });
}

function noNarration(sceneId: string): Result<never, DomainError> {
  return err({
    code: ErrorCode.InvariantViolated,
    message: `scene ${sceneId} has no generated narration timings`,
  });
}
