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
    description: "List available VidCom projects with dimensions, duration, current project revision, and write-recovery status. Use projectId from this result for project-scoped tools.",
    input: ListProjectsInputSchema,
    output: ListProjectsOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async () => {
      const result = await listProjectContexts(dependencies);
      return result.ok ? ok({ projects: result.value }) : result;
    },
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
    description: "Read the bounded project, compact scenes, file hashes, entity/project revisions, diagnostics, preview settings, and recovery gate needed to plan a safe next edit.",
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
    description: "List compact scene timing, source hash, narration-stale state, current project revision, and recovery gate without loading the full project context.",
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
    description: "Read one allowlisted project-relative composition source with its content hash and recovery gate. Rejects paths outside the project, disallowed assets, and files over the source-size limit.",
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
