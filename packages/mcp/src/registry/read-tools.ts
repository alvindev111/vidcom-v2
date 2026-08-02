import type { z } from "zod";

import {
  GetProjectContextInputSchema,
  GetProjectContextOutputSchema,
  ListScenesInputSchema,
  ListScenesOutputSchema,
  ReadCompositionInputSchema,
  ReadCompositionOutputSchema,
  ListProjectsInputSchema,
  ListProjectsOutputSchema,
} from "@vidcom/contracts";
import {
  getProjectContext,
  listProjectContexts,
  listSceneContexts,
  ok,
  readComposition,
  type ProjectReadDependencies,
} from "@vidcom/core";
import type { ProjectId } from "@vidcom/contracts";
import type { RelPath } from "@vidcom/contracts";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export type ReadToolDependencies = ProjectReadDependencies;

/** Lists bounded project identities and recovery status so an agent can choose a project safely. */
export function listProjectsTool(
  dependencies: ReadToolDependencies,
): ToolDefinition<z.infer<typeof ListProjectsInputSchema>, z.infer<typeof ListProjectsOutputSchema>> {
  return {
    name: "list_projects",
    title: "List VidCom projects",
    level: "read",
    description: [
      "Use when you need to discover a VidCom projectId and its summary or write-recovery status.",
      "Do not use for scene details, source content, or mutation preconditions.",
      "Preconditions: none; use limit/cursor to page and a returned projectId for project-scoped tools.",
      "Side effects: read-only; no project files or revisions are changed.",
      "Errors/recovery: resolve workspace or project read errors before retrying; if recovery is blocked, complete the configured recovery flow before writes.",
    ].join(" "),
    input: ListProjectsInputSchema,
    output: ListProjectsOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async (_context, input) => listProjectContexts(dependencies, input),
  };
}

export function registerListProjects(registry: ToolRegistry, dependencies: ReadToolDependencies): void {
  registry.register(listProjectsTool(dependencies));
}

export function getProjectContextTool(
  dependencies: ReadToolDependencies,
): ToolDefinition<z.infer<typeof GetProjectContextInputSchema>, z.infer<typeof GetProjectContextOutputSchema>> {
  return {
    name: "get_project_context",
    title: "Get project editing context",
    level: "read",
    description: [
      "Use when planning an edit and you need compact scenes, canonical file hashes, revisions, diagnostics, preview settings, and the recovery gate.",
      "Do not use when you need full composition source; use read_composition instead.",
      "Preconditions: projectId comes from list_projects; this read has no mutation precondition.",
      "Side effects: read-only; no project files or revisions are changed.",
      "Errors/recovery: refresh list_projects after project_not_found; when recovery is blocked, stop mutations and complete the configured recovery flow before retrying.",
    ].join(" "),
    input: GetProjectContextInputSchema,
    output: GetProjectContextOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => {
      const result = await getProjectContext(dependencies, input.projectId as ProjectId);
      return result.ok ? ok(GetProjectContextOutputSchema.parse(result.value)) : result;
    },
  };
}

export function listScenesTool(
  dependencies: ReadToolDependencies,
): ToolDefinition<z.infer<typeof ListScenesInputSchema>, z.infer<typeof ListScenesOutputSchema>> {
  return {
    name: "list_scenes",
    title: "List project scenes",
    level: "read",
    description: [
      "Use when you need compact scene timing, source hashes and availability diagnostics, narration state, project revision, and recovery status without full source content.",
      "Do not use for editing source text or reading complete composition markup.",
      "Preconditions: projectId comes from list_projects; this read has no mutation precondition.",
      "Side effects: read-only; no scene or revision is changed.",
      "Errors/recovery: refresh list_projects after project_not_found; when recovery is blocked, stop mutations and complete recovery before retrying.",
    ].join(" "),
    input: ListScenesInputSchema,
    output: ListScenesOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => {
      const result = await listSceneContexts(dependencies, input.projectId as ProjectId);
      return result.ok ? ok(ListScenesOutputSchema.parse(result.value)) : result;
    },
  };
}

export function registerProjectContextTools(registry: ToolRegistry, dependencies: ReadToolDependencies): void {
  registry.register(getProjectContextTool(dependencies));
  registry.register(listScenesTool(dependencies));
}

export function readCompositionTool(
  dependencies: ReadToolDependencies,
): ToolDefinition<z.infer<typeof ReadCompositionInputSchema>, z.infer<typeof ReadCompositionOutputSchema>> {
  return {
    name: "read_composition",
    title: "Read composition source",
    level: "read",
    description: [
      "Use when you need one allowlisted project-relative composition source and its current content hash before a source write.",
      "Do not use for binary assets, external paths, or project-wide context.",
      "Preconditions: projectId comes from list_projects and path comes from project context or another trusted project-relative reference; no expected hash is required.",
      "Side effects: read-only; no source file or revision is changed.",
      "Errors/recovery: correct path_invalid, path_outside_project, asset_not_allowed, not_found, or source-size limit errors; if recovery is blocked, recover the project before writing.",
    ].join(" "),
    input: ReadCompositionInputSchema,
    output: ReadCompositionOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => readComposition(
      dependencies,
      input.projectId as ProjectId,
      input.path as RelPath,
    ),
  };
}

export function registerReadComposition(registry: ToolRegistry, dependencies: ReadToolDependencies): void {
  registry.register(readCompositionTool(dependencies));
}
