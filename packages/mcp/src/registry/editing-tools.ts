import type { z } from "zod";

import {
  DeleteScenesInputSchema,
  DeleteScenesOutputSchema,
  MoveScenesInputSchema,
  MoveScenesOutputSchema,
  ReorderScenesInputSchema,
  ReorderScenesOutputSchema,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  deleteScenes,
  moveScenes,
  prepareDeleteScenes,
  readSourceFile,
  reorderScenes,
  type ProjectReadDependencies,
  type ProjectWriteDependencies,
  type DeleteScenesDependencies,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import { requestDestructiveApproval } from "./destructive-tools";
import type { RegistryApprovalDependencies, ToolDefinition } from "./types";

export type EditingToolDependencies = ProjectWriteDependencies
  & DeleteScenesDependencies
  & RegistryApprovalDependencies
  & { reads: ProjectReadDependencies };

/** The entry composition as the HTTP surface returns it beside a scene-order write. */
async function entryFile(dependencies: EditingToolDependencies, projectId: ProjectId) {
  return readSourceFile(dependencies.reads, projectId, "index.html" as RelPath);
}

export function reorderScenesTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof ReorderScenesInputSchema>, z.infer<typeof ReorderScenesOutputSchema>> {
  return {
    name: "reorder_scenes",
    title: "Reorder one scene",
    level: "write",
    description: [
      "Use when moving one existing scene to a different position, or onto a different track, and letting the timeline close the gap it leaves.",
      "Do not use to change a scene's own start or duration, to move several scenes together, or to delete one.",
      "Preconditions: sceneId, toIndex and expectedContentHash come from read_composition or get_project_context; pass extendRoot only after a root-overflow refusal that says it is allowed.",
      "Side effects: rewrites the entry composition in one revision, shifting the scenes the move displaces and growing the root only when extendRoot was asked for.",
      "Errors/recovery: on write_conflict re-read the entry composition; a duration_overflow names the limit it hit; on recovery_required stop writes and recover; committed_response_error means the mutation committed, so do not retry it.",
    ].join(" "),
    input: ReorderScenesInputSchema,
    output: ReorderScenesOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const projectId = input.projectId as ProjectId;
      const ordered = await reorderScenes(dependencies, {
        projectId,
        sceneId: input.sceneId,
        toIndex: input.toIndex,
        ...(input.toTrackIndex === undefined ? {} : { toTrackIndex: input.toTrackIndex }),
        ...(input.extendRoot === undefined ? {} : { extendRoot: input.extendRoot }),
        expectedContentHash: input.expectedContentHash as ContentHash,
      }, context.actor, context.writeInvocation);
      if (!ordered.ok) return ordered;
      const file = await entryFile(dependencies, projectId);
      if (!file.ok) return file;
      return {
        ok: true as const,
        value: {
          changed: ordered.value.changed,
          changes: ordered.value.changes,
          file: file.value,
          revision: ordered.value.envelope?.projectRevision ?? ordered.value.project.revision,
          diagnostics: ordered.value.diagnostics,
          changeSeq: ordered.value.envelope?.changeSeq ?? null,
        },
      };
    },
  };
}

export function moveScenesTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof MoveScenesInputSchema>, z.infer<typeof MoveScenesOutputSchema>> {
  return {
    name: "move_scenes",
    title: "Move several scenes together",
    level: "write",
    description: [
      "Use when shifting a whole selection of scenes by the same amount of time while keeping the gaps between them.",
      "Do not use to reorder one scene, to change durations, or to move scenes onto another track.",
      "Preconditions: sceneIds must be unique and current, deltaSeconds is the shift in seconds, and expectedContentHash comes from read_composition; pass extendRoot only after a root-overflow refusal that says it is allowed.",
      "Side effects: applies the whole shift in one revision or none of it, so a refused group leaves the timeline untouched.",
      "Errors/recovery: on write_conflict re-read the entry composition; timing_invalid or duration_overflow names what the group would have broken; on recovery_required stop writes and recover; never retry committed_response_error.",
    ].join(" "),
    input: MoveScenesInputSchema,
    output: MoveScenesOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const projectId = input.projectId as ProjectId;
      const moved = await moveScenes(dependencies, {
        projectId,
        sceneIds: input.sceneIds,
        deltaSeconds: input.deltaSeconds,
        ...(input.extendRoot === undefined ? {} : { extendRoot: input.extendRoot }),
        expectedContentHash: input.expectedContentHash as ContentHash,
      }, context.actor, context.writeInvocation);
      if (!moved.ok) return moved;
      const file = await entryFile(dependencies, projectId);
      if (!file.ok) return file;
      return {
        ok: true as const,
        value: {
          changed: moved.value.changed,
          changes: moved.value.changes,
          file: file.value,
          revision: moved.value.envelope?.projectRevision ?? moved.value.project.revision,
          diagnostics: moved.value.diagnostics,
          changeSeq: moved.value.envelope?.changeSeq ?? null,
        },
      };
    },
  };
}

export function deleteScenesTool(
  dependencies: EditingToolDependencies,
): ToolDefinition<z.infer<typeof DeleteScenesInputSchema>, z.infer<typeof DeleteScenesOutputSchema>> {
  return {
    name: "delete_scenes",
    title: "Delete several scenes",
    level: "destructive",
    description: [
      "Use when permanently removing a whole selection of scenes, their mounts, unique sources and narration, with one verified backup.",
      "Do not use to hide or reorder scenes, to delete a single scene when delete_scene already covers it, or when shared references must remain.",
      "Preconditions: sceneIds and expectedRevision come from current project context; omit grantId to create one approval request for the whole group, then retry once with the issued grantId and the identical selection.",
      "Side effects: after approval, deletes every owned artifact of the selection, updates the root duration, publishes one backup and commits one destructive revision.",
      "Errors/recovery: refresh context after write_conflict; request new approval after approval_invalid or approval_expired; on recovery_required stop and recover; never retry committed_response_error.",
    ].join(" "),
    input: DeleteScenesInputSchema,
    output: DeleteScenesOutputSchema,
    annotations: annotationsForLevel("destructive"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const projectId = input.projectId as ProjectId;
      if (!input.grantId) {
        const prepared = await prepareDeleteScenes(dependencies, {
          projectId,
          sceneIds: input.sceneIds,
          expectedRevision: input.expectedRevision,
        });
        if (!prepared.ok) return prepared;
        return requestDestructiveApproval(
          dependencies.approvals,
          context,
          prepared.value.binding,
          `Delete ${prepared.value.plan.sceneIds.length} scenes`,
          `delete ${prepared.value.plan.sceneIds.length} scenes`,
          "delete_scenes",
        );
      }
      const deleted = await deleteScenes(dependencies, {
        projectId,
        sceneIds: input.sceneIds,
        expectedRevision: input.expectedRevision,
        grantId: input.grantId,
      }, context.actor, context.writeInvocation);
      if (!deleted.ok) return deleted;
      return {
        ok: true as const,
        value: {
          project: deleted.value.project,
          revision: deleted.value.envelope.projectRevision,
          diagnostics: deleted.value.envelope.diagnostics,
          changeSeq: deleted.value.envelope.changeSeq,
          backupId: deleted.value.backupId,
          deletedFiles: deleted.value.deletedFiles,
          keptFiles: deleted.value.keptFiles,
        },
      };
    },
  };
}

export function registerEditingTools(registry: ToolRegistry, dependencies: EditingToolDependencies): void {
  registry.register(reorderScenesTool(dependencies));
  registry.register(moveScenesTool(dependencies));
  registry.register(deleteScenesTool(dependencies));
}
