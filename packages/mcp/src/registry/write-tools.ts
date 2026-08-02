import type { z } from "zod";

import {
  CreateSceneInputSchema,
  CreateSceneOutputSchema,
  SetSceneTimingInputSchema,
  SetSceneTimingOutputSchema,
  SetTextInputSchema,
  SetTextOutputSchema,
  SaveFileInputSchema,
  SaveFileOutputSchema,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  createScene,
  saveSourceFile,
  setSceneScript,
  setSceneTiming,
  type ProjectWriteDependencies,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export type WriteToolDependencies = ProjectWriteDependencies;

export function createSceneTool(
  dependencies: WriteToolDependencies,
): ToolDefinition<z.infer<typeof CreateSceneInputSchema>, z.infer<typeof CreateSceneOutputSchema>> {
  return {
    name: "create_scene",
    title: "Create a scene",
    level: "write",
    description: "Create one scene source, mount it in the entry composition, and create its narration sidecar atomically. Requires the current entry-file expectedContentHash; stale or missing preconditions do not write.",
    input: CreateSceneInputSchema,
    output: CreateSceneOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => createScene(dependencies, {
      ...input,
      projectId: input.projectId as ProjectId,
      expectedContentHash: input.expectedContentHash as ContentHash,
    }, context.actor, context.writeInvocation),
  };
}

export function setSceneTimingTool(
  dependencies: WriteToolDependencies,
): ToolDefinition<z.infer<typeof SetSceneTimingInputSchema>, z.infer<typeof SetSceneTimingOutputSchema>> {
  return {
    name: "set_scene_timing",
    title: "Set scene timing",
    level: "write",
    description: "Update a scene start, duration, or track index using the current entry-file expectedContentHash. Returns the updated compact scene, project, hashes, revisions, and diagnostics; invalid timing or stale hashes do not write.",
    input: SetSceneTimingInputSchema,
    output: SetSceneTimingOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => setSceneTiming(dependencies, {
      projectId: input.projectId as ProjectId,
      sceneId: input.sceneId,
      timing: {
        ...(input.start === undefined ? {} : { start: input.start }),
        ...(input.duration === undefined ? {} : { duration: input.duration }),
        ...(input.trackIndex === undefined ? {} : { trackIndex: input.trackIndex }),
      },
      expectedContentHash: input.expectedContentHash,
    }, context.actor, context.writeInvocation),
  };
}

export function registerSceneWriteTools(registry: ToolRegistry, dependencies: WriteToolDependencies): void {
  registry.register(createSceneTool(dependencies));
  registry.register(setSceneTimingTool(dependencies));
}

export function setTextTool(
  dependencies: WriteToolDependencies,
): ToolDefinition<z.infer<typeof SetTextInputSchema>, z.infer<typeof SetTextOutputSchema>> {
  return {
    name: "set_text",
    title: "Set scene text",
    level: "write",
    description: "Update one text element with the source file expectedContentHash. If the scene has narration, marks its sidecar stale in the same revision and returns narrationStale=true; it does not run TTS.",
    input: SetTextInputSchema,
    output: SetTextOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => setSceneScript(dependencies, {
      ...input,
      projectId: input.projectId as ProjectId,
      file: input.file as RelPath,
    }, context.actor, context.writeInvocation),
  };
}

export function saveFileTool(
  dependencies: WriteToolDependencies,
): ToolDefinition<z.infer<typeof SaveFileInputSchema>, z.infer<typeof SaveFileOutputSchema>> {
  return {
    name: "save_file",
    title: "Save composition source",
    level: "write",
    description: "Save one allowlisted project-relative text/composition file with expectedContentHash. Protected project metadata and oversized source are rejected; returns the new content hash and write envelope.",
    input: SaveFileInputSchema,
    output: SaveFileOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => saveSourceFile(dependencies, {
      ...input,
      projectId: input.projectId as ProjectId,
      path: input.path as RelPath,
    }, context.actor, context.writeInvocation),
  };
}

export function registerSourceWriteTools(registry: ToolRegistry, dependencies: WriteToolDependencies): void {
  registry.register(setTextTool(dependencies));
  registry.register(saveFileTool(dependencies));
}
