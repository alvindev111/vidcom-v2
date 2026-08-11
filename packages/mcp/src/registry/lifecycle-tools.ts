import type { z } from "zod";

import {
  AdoptProjectInputSchema,
  AdoptProjectOutputSchema,
  CreateProjectInputSchema,
  CreateProjectOutputSchema,
  DeleteProjectInputSchema,
  DeleteProjectOutputSchema,
  RenameProjectInputSchema,
  RenameProjectOutputSchema,
  type ProjectId,
} from "@vidcom/contracts";
import { resolvePlatformPreset, type ProjectLifecycle } from "@vidcom/core";

import { requestDestructiveApproval } from "./destructive-tools";
import { annotationsForLevel, ToolRegistry } from "./registry";
import type { RegistryApprovalDependencies, ToolDefinition } from "./types";

export interface LifecycleToolDependencies extends RegistryApprovalDependencies {
  lifecycle: ProjectLifecycle;
}

/**
 * Creates the project a headless agent has nowhere else to get.
 *
 * Only a name and a preset: the workspace root is process state, so nothing a
 * caller sends can decide where the directory lands.
 */
export function createProjectTool(
  dependencies: LifecycleToolDependencies,
): ToolDefinition<z.infer<typeof CreateProjectInputSchema>, z.infer<typeof CreateProjectOutputSchema>> {
  return {
    name: "create_project",
    title: "Create a VidCom project",
    level: "write",
    description: [
      "Use when starting a new video from nothing, before any other project-scoped tool can be called.",
      "Do not use to re-create an existing project, to adopt a folder that already holds a composition, or to choose where the project is stored.",
      "Preconditions: name must produce a slug of letters, digits and hyphens; presetId is vertical-shorts, horizontal-youtube, or custom, and only custom accepts width, height and fps.",
      "Side effects: creates the project directory inside the active workspace with vidcom.json, hyperframes.json, preview-settings.json and an index.html root composition, as one journaled lifecycle write.",
      "Errors/recovery: fix schema_invalid on the name or preset fields; write_conflict means that slug is taken, so choose another name; storage_unavailable means no workspace is active, which only the UI or CLI can fix.",
    ].join(" "),
    input: CreateProjectInputSchema,
    output: CreateProjectOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async (context, input) => {
      const preset = resolvePlatformPreset(input);
      if (!preset.ok) return preset;
      return dependencies.lifecycle.create(
        { name: input.name, preset: preset.value, actor: context.actor },
        context.writeInvocation,
      );
    },
  };
}

/**
 * Turns a folder somebody dropped into the workspace into a project.
 *
 * Takes a slug, never a path: the folder must already sit in the active
 * workspace, so adoption cannot reach anything the workspace does not contain.
 */
export function adoptProjectTool(
  dependencies: LifecycleToolDependencies,
): ToolDefinition<z.infer<typeof AdoptProjectInputSchema>, z.infer<typeof AdoptProjectOutputSchema>> {
  return {
    name: "adopt_project",
    title: "Adopt a workspace folder",
    level: "write",
    description: [
      "Use when a HyperFrames folder already sits in the workspace unowned and needs a VidCom identity before it can be edited.",
      "Do not use for a folder outside the workspace, for a project that already has vidcom.json, or to create a project from nothing.",
      "Preconditions: slug is the folder name directly inside the active workspace, and that folder must contain hyperframes.json but no vidcom.json.",
      "Side effects: writes vidcom.json with a new projectId, seeds preview settings, and registers the project in one journaled bootstrap write.",
      "Errors/recovery: project_not_found means no such folder; write_conflict means it is already adopted; composition_parse_error means its index.html must be fixed before adoption.",
    ].join(" "),
    input: AdoptProjectInputSchema,
    output: AdoptProjectOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: (context, input) => dependencies.lifecycle.adopt(
      { slug: input.slug, actor: context.actor },
      context.writeInvocation,
    ),
  };
}

export function renameProjectTool(
  dependencies: LifecycleToolDependencies,
): ToolDefinition<z.infer<typeof RenameProjectInputSchema>, z.infer<typeof RenameProjectOutputSchema>> {
  return {
    name: "rename_project",
    title: "Rename a project",
    level: "write",
    description: [
      "Use when the project's title and folder slug must change together.",
      "Do not use to move a project between workspaces, to change composition content, or while one of its jobs is running.",
      "Preconditions: projectId comes from list_projects and name must produce a valid slug.",
      "Side effects: renames the project directory and updates its registration in one journaled lifecycle write; every project-relative path stays valid.",
      "Errors/recovery: schema_invalid means the name yields no slug; write_conflict means the target slug exists or a render, snapshot or narration job is running, so wait for get_job_status to report a terminal outcome and retry.",
    ].join(" "),
    input: RenameProjectInputSchema,
    output: RenameProjectOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: (context, input) => dependencies.lifecycle.rename(
      { kind: "project", projectId: input.projectId as ProjectId },
      input.name,
      context.actor,
      context.writeInvocation,
    ),
  };
}

/**
 * Deletes a whole project behind the same approval gate as scene and file deletion.
 *
 * `confirmed` plus an issued grant, because this is the only tool whose mistake
 * costs every file in the directory at once.
 */
export function deleteProjectTool(
  dependencies: LifecycleToolDependencies,
): ToolDefinition<z.infer<typeof DeleteProjectInputSchema>, z.infer<typeof DeleteProjectOutputSchema>> {
  return {
    name: "delete_project",
    title: "Delete a project",
    level: "destructive",
    description: [
      "Use when permanently removing one entire project directory with a verified backup.",
      "Do not use to remove a single scene or file, to archive a project, or without the user asking for deletion in those words.",
      "Preconditions: projectId comes from list_projects, confirmed must be true, and omitting grantId creates an approval request to retry once with the issued grantId.",
      "Side effects: after approval, verifies a full backup, quarantines and removes the directory, consumes the grant, and commits one destructive lifecycle revision returning backupId.",
      "Errors/recovery: write_conflict means a running job or a file that changed after approval, so re-plan; backup_failed means nothing was deleted; request new approval after approval_invalid or approval_expired; recovery_required means the deletion is half-applied and must be recovered before anything else.",
    ].join(" "),
    input: DeleteProjectInputSchema,
    output: DeleteProjectOutputSchema,
    annotations: annotationsForLevel("destructive"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const locator = { kind: "project" as const, projectId: input.projectId as ProjectId };
      if (!input.grantId) {
        const planned = await dependencies.lifecycle.planRemove(locator);
        if (!planned.ok) return planned;
        return requestDestructiveApproval(
          dependencies.approvals,
          context,
          planned.value.binding,
          planned.value.summary,
          `delete project ${input.projectId}`,
          "delete_project",
        );
      }
      // The registry stamps every tool invocation as the agent actor; removal
      // authority spells that out because a `user` actor would skip the grant.
      return dependencies.lifecycle.remove(
        locator,
        { actor: "agent", confirmed: true, grantId: input.grantId },
        context.writeInvocation,
      );
    },
  };
}

export function registerLifecycleTools(registry: ToolRegistry, dependencies: LifecycleToolDependencies): void {
  registry.register(createProjectTool(dependencies));
  registry.register(adoptProjectTool(dependencies));
  registry.register(renameProjectTool(dependencies));
  registry.register(deleteProjectTool(dependencies));
}
