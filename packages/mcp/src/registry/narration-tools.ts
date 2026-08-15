import type { z } from "zod";

import {
  GetNarrationCuesInputSchema,
  GetNarrationCuesOutputSchema,
  NarrationCuesWriteOutputSchema,
  PatchNarrationCueInputSchema,
  ReplaceNarrationCuesInputSchema,
  type ContentHash,
  type ProjectId,
} from "@vidcom/contracts";
import {
  ok,
  patchNarrationCue,
  readNarrationCues,
  replaceNarrationCues,
  type NarrationCue,
  type ProjectWriteDependencies,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export type NarrationToolDependencies = ProjectWriteDependencies;

/** Projects one cue onto the published contract, leaving engine word timings out of the tool surface. */
function cueState(cue: NarrationCue) {
  return {
    cueId: cue.cueId,
    text: cue.text,
    voice: cue.voice,
    offsetSeconds: cue.offsetSeconds,
    durationSeconds: cue.durationSeconds,
    staleSince: cue.staleSince,
    status: cue.status ?? null,
    audioPath: cue.audioPath ?? null,
  };
}

export function getNarrationCuesTool(
  dependencies: NarrationToolDependencies,
): ToolDefinition<z.infer<typeof GetNarrationCuesInputSchema>, z.infer<typeof GetNarrationCuesOutputSchema>> {
  return {
    name: "get_narration_cues",
    title: "Read scene narration cues",
    level: "read",
    description: [
      "Use when you need one scene's authored narration cues, their offsets and their synthesis staleness before writing cues or calling start_tts.",
      "Do not use to read composition source or to list scenes.",
      "Preconditions: projectId comes from list_projects and sceneId comes from list_scenes.",
      "Side effects: read-only; a scene with no sidecar returns an empty cue list and a null contentHash instead of an error.",
      "Errors/recovery: project_invalid means the sidecar is corrupt and must be replaced with replace_narration_cues; carry contentHash into the next cue write as its precondition.",
    ].join(" "),
    input: GetNarrationCuesInputSchema,
    output: GetNarrationCuesOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => {
      const read = await readNarrationCues(dependencies, {
        projectId: input.projectId as ProjectId,
        sceneId: input.sceneId,
      });
      return read.ok
        ? ok({ cues: read.value.cues.map(cueState), contentHash: read.value.contentHash })
        : read;
    },
  };
}

/**
 * Replaces the whole cue set for one scene.
 *
 * Deliberately resets synthesis metadata: cues authored now have no audio yet,
 * and keeping the old timings would make a stale WAV look current.
 */
export function replaceNarrationCuesTool(
  dependencies: NarrationToolDependencies,
): ToolDefinition<z.infer<typeof ReplaceNarrationCuesInputSchema>, z.infer<typeof NarrationCuesWriteOutputSchema>> {
  return {
    name: "replace_narration_cues",
    title: "Replace scene narration cues",
    level: "write",
    description: [
      "Use when writing or rewriting the complete spoken script of one scene before start_tts.",
      "Do not use to edit a single cue, to change on-screen text, or to synthesize audio.",
      "Preconditions: projectId and sceneId come from project context, cueIds must be unique, and expectedContentHash comes from get_narration_cues — null when that scene has no sidecar yet.",
      "Side effects: rewrites narration/<sceneId>.json as one journaled write, resets synthesis metadata for every cue, and commits one project revision; existing audio becomes stale.",
      "Errors/recovery: write_conflict means the sidecar changed, so re-read get_narration_cues; schema_invalid on cues means duplicate cueIds; run start_tts afterwards to produce audio again.",
    ].join(" "),
    input: ReplaceNarrationCuesInputSchema,
    output: NarrationCuesWriteOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const written = await replaceNarrationCues(dependencies, {
        projectId: input.projectId as ProjectId,
        sceneId: input.sceneId,
        cues: input.cues,
        expectedContentHash: input.expectedContentHash as ContentHash | null,
      }, context.actor, context.writeInvocation);
      return written.ok
        ? ok({
            cues: written.value.cues.map(cueState),
            contentHash: written.value.contentHash,
            revision: written.value.revision,
          })
        : written;
    },
  };
}

export function patchNarrationCueTool(
  dependencies: NarrationToolDependencies,
): ToolDefinition<z.infer<typeof PatchNarrationCueInputSchema>, z.infer<typeof NarrationCuesWriteOutputSchema>> {
  return {
    name: "patch_narration_cue",
    title: "Update one narration cue",
    level: "write",
    description: [
      "Use when correcting the text, voice or offset of exactly one existing cue while its siblings keep their synthesis state.",
      "Do not use to add or remove cues, which replace_narration_cues owns, and do not use to synthesize audio.",
      "Preconditions: projectId, sceneId, cueId and expectedContentHash come from get_narration_cues, and at least one of text, voice or offsetSeconds must be present.",
      "Side effects: rewrites the sidecar as one journaled write and commits one revision; changing text or voice marks only that cue stale, while an offset change keeps its audio valid.",
      "Errors/recovery: not_found means that cueId is gone; write_conflict means the sidecar changed, so re-read it; re-run start_tts for cues whose staleSince is set.",
    ].join(" "),
    input: PatchNarrationCueInputSchema,
    output: NarrationCuesWriteOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const written = await patchNarrationCue(dependencies, {
        projectId: input.projectId as ProjectId,
        sceneId: input.sceneId,
        cueId: input.cueId,
        patch: {
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.voice === undefined ? {} : { voice: input.voice }),
          ...(input.offsetSeconds === undefined ? {} : { offsetSeconds: input.offsetSeconds }),
        },
        expectedContentHash: input.expectedContentHash as ContentHash,
      }, context.actor, context.writeInvocation);
      return written.ok
        ? ok({
            cues: written.value.cues.map(cueState),
            contentHash: written.value.contentHash,
            revision: written.value.revision,
          })
        : written;
    },
  };
}

export function registerNarrationTools(registry: ToolRegistry, dependencies: NarrationToolDependencies): void {
  registry.register(getNarrationCuesTool(dependencies));
  registry.register(replaceNarrationCuesTool(dependencies));
  registry.register(patchNarrationCueTool(dependencies));
}
