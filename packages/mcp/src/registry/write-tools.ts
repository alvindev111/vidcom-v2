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
    description: [
      "Use when adding one new mounted scene with a source file and narration sidecar.",
      "Do not use to edit an existing scene or save an arbitrary source file.",
      "Preconditions: entry-file expectedContentHash must be the current entry-composition hash from get_project_context or read_composition.",
      "Side effects: atomically creates the scene source and narration, updates the entry composition and root duration, and commits one revision.",
      "Errors/recovery: on write_conflict refresh context and re-plan; on recovery_required stop writes and recover; committed_response_error means the mutation committed, so do not retry it.",
    ].join(" "),
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
    description: [
      "Use when changing at least one existing scene start, duration, or track index.",
      "Do not use for source text, scene creation, or an empty timing patch.",
      "Preconditions: sceneId and expectedContentHash must come from current project context; the hash is for the entry composition.",
      "Side effects: atomically updates scene timing and root duration and commits one revision.",
      "Errors/recovery: fix schema_invalid timing; on write_conflict refresh context and re-plan; on recovery_required recover first; never retry a committed_response_error mutation.",
    ].join(" "),
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
    description: [
      "Use when replacing the text of one existing script element in an allowlisted scene source.",
      "Do not use to replace arbitrary markup, create elements, or run TTS.",
      "Preconditions: file, elementId, and expectedContentHash come from current project context or read_composition; the hash is for that source file.",
      "Side effects: atomically updates the source and, only when narration exists, marks its sidecar stale and returns narrationStale=true in the same revision; it does not run TTS.",
      "Errors/recovery: on not_found or write_conflict refresh the source and re-plan; on recovery_required recover first; never retry a committed_response_error mutation.",
    ].join(" "),
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
    description: [
      "Use when replacing the complete content of one allowlisted project-relative text or composition source.",
      "Do not use for binary assets, oversized content, or targeted text edits better handled by set_text. Protected project metadata is rejected.",
      "Preconditions: path and expectedContentHash come from read_composition or current project context; the hash is for that exact file.",
      "Side effects: atomically replaces that source file, returns its new content hash, and commits one revision.",
      "Errors/recovery: correct path or size errors; on write_conflict re-read and re-plan; on recovery_required recover first; never retry a committed_response_error mutation.",
    ].join(" "),
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
