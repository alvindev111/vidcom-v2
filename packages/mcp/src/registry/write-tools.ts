import type { z } from "zod";

import {
  CreateSceneInputSchema,
  CreateSceneOutputSchema,
  InstallMotionLibraryInputSchema,
  InstallMotionLibraryOutputSchema,
  SetSceneTimingInputSchema,
  SetSceneTimingOutputSchema,
  SetElementPositionInputSchema,
  SetElementPositionOutputSchema,
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
  installMotionLibrary,
  saveSourceFile,
  setSceneScript,
  setSceneTiming,
  setElementPosition,
  type MotionLibraryInstallDependencies,
  type ProjectWriteDependencies,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export type WriteToolDependencies = ProjectWriteDependencies & MotionLibraryInstallDependencies;

export function createSceneTool(
  dependencies: WriteToolDependencies,
): ToolDefinition<z.infer<typeof CreateSceneInputSchema>, z.infer<typeof CreateSceneOutputSchema>> {
  return {
    name: "create_scene",
    title: "Create a scene",
    level: "write",
    description: [
      "Use when adding one new mounted story beat with a source file and narration sidecar.",
      "Do not use to edit an existing scene, save an arbitrary source file, or add a beat whose narrative role and handoff are not yet defined.",
      "Preconditions: entry-file expectedContentHash must be the current entry-composition hash from get_project_context or read_composition; before calling, the storyboard names this beat's role, viewer experience, meaningful visual change, multi-phase choreography, and transition.",
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
      expectedContentHash: input.expectedContentHash as ContentHash | null,
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
      ripple: input.ripple,
      extendRoot: input.extendRoot,
      expectedContentHash: input.expectedContentHash,
    }, context.actor, context.writeInvocation),
  };
}

export function setElementPositionTool(
  dependencies: WriteToolDependencies,
): ToolDefinition<z.infer<typeof SetElementPositionInputSchema>, z.infer<typeof SetElementPositionOutputSchema>> {
  return {
    name: "set_element_position",
    title: "Set element position",
    level: "write",
    description: [
      "Use when moving one selected authored element or generated caption group by a base x/y offset.",
      "Do not use for resize, rotation, motion keyframes, selectors, source paths, or elements reported as positionEditable=false.",
      "Preconditions: sceneId, elementId and expectedContentHash must come from current list_scenes/read_composition state for the exact source owner.",
      "Side effects: writes only VidCom-owned layout offset metadata, preserves authored transform motion, and commits at most one revision; an unchanged offset returns changed=false.",
      "Errors/recovery: refresh on not_found or write_conflict; a position_locked invariant requires an authored data-hf-id without authored translate.",
    ].join(" "),
    input: SetElementPositionInputSchema,
    output: SetElementPositionOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => setElementPosition(dependencies, {
      ...input,
      projectId: input.projectId as ProjectId,
    }, context.actor, context.writeInvocation),
  };
}

export function registerSceneWriteTools(registry: ToolRegistry, dependencies: WriteToolDependencies): void {
  registry.register(createSceneTool(dependencies));
  registry.register(setSceneTimingTool(dependencies));
  registry.register(setElementPositionTool(dependencies));
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
      "Use when replacing the complete content of one allowlisted project-relative text or composition source, including authored story choreography.",
      "Do not use for binary assets, oversized content, targeted text edits better handled by set_text, or a story scene whose only motion is fade, gentle rise/drop, or repeated opacity-plus-translate. Protected project metadata is rejected.",
      "Preconditions: path and expectedContentHash come from read_composition or current project context; the hash is for that exact file. A story scene source must implement setup, development, payoff and hold with motion that reveals meaning or changes visual state.",
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

export function installMotionLibraryTool(
  dependencies: WriteToolDependencies,
): ToolDefinition<
  z.infer<typeof InstallMotionLibraryInputSchema>,
  z.infer<typeof InstallMotionLibraryOutputSchema>
> {
  return {
    name: "install_motion_library",
    title: "Vendor a motion library",
    level: "write",
    description: [
      "Use when a composition needs GSAP, Anime.js, Motion One, Lottie, or Three.js before referencing it in source; GSAP is the default for the multi-phase choreography required by story scenes.",
      "Do not use to add a CDN script tag, install an arbitrary npm package, write the composition markup itself, or substitute a library install for an actual motion map.",
      "Preconditions: projectId comes from list_projects; the library version is pinned by the studio and is not caller-selectable.",
      "Side effects: copies the pinned library into assets/vendor/ as one atomic mutation and commits one revision; re-running returns already_installed without a write.",
      "Errors/recovery: returns the paste-ready scriptTag and entry path to use; on write_conflict re-read and retry; storage_unavailable means the studio install is incomplete, so report it instead of falling back to a CDN.",
    ].join(" "),
    input: InstallMotionLibraryInputSchema,
    output: InstallMotionLibraryOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => installMotionLibrary(dependencies, {
      projectId: input.projectId as ProjectId,
      libraryId: input.libraryId,
    }, context.actor, context.writeInvocation),
  };
}

export function registerSourceWriteTools(registry: ToolRegistry, dependencies: WriteToolDependencies): void {
  registry.register(setTextTool(dependencies));
  registry.register(saveFileTool(dependencies));
  registry.register(installMotionLibraryTool(dependencies));
}
