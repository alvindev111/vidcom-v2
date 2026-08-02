import type { z } from "zod";

import {
  DeleteSceneInputSchema,
  DeleteSceneOutputSchema,
  DeleteFileInputSchema,
  DeleteFileOutputSchema,
  ErrorCode,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  deleteScene,
  deleteFile,
  err,
  prepareSceneDeletion,
  prepareFileDeletion,
  type DeleteFileDependencies,
  type DeleteSceneDependencies,
  type GrantBinding,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { RegistryApprovalDependencies, ToolContext, ToolDefinition } from "./types";

export type DestructiveToolDependencies = DeleteSceneDependencies & DeleteFileDependencies & RegistryApprovalDependencies;

async function requestDestructiveApproval(
  approvals: RegistryApprovalDependencies["approvals"],
  context: ToolContext,
  binding: GrantBinding,
  summary: string,
  targetDescription: string,
  retryTool: string,
) {
  const requestId = await approvals.request(binding, summary);
  if (context.era === "modern") {
    return context.requestInput({
      message: `Approval is required to ${targetDescription}. Approve request ${requestId}, then retry with its issued grantId.`,
      requestState: requestId,
      schema: {
        type: "object",
        properties: { grantId: { type: "string", description: "Issued approval grant ID" } },
        required: ["grantId"],
        additionalProperties: false,
      },
    });
  }
  return err({
    code: ErrorCode.ApprovalRequired,
    message: `Approval request ${requestId} must be issued, then retry ${retryTool} with grantId.`,
    details: { requestId },
  });
}

/** Creates one approval request and maps the negotiated era to modern input-required or legacy error. */
export async function requestSceneDeletionApproval(
  approvals: RegistryApprovalDependencies["approvals"],
  context: ToolContext,
  binding: GrantBinding,
  sceneId: string,
) {
  return requestDestructiveApproval(
    approvals,
    context,
    binding,
    `Delete scene ${sceneId}`,
    `delete scene ${sceneId}`,
    "delete_scene",
  );
}

export async function requestFileDeletionApproval(
  approvals: RegistryApprovalDependencies["approvals"],
  context: ToolContext,
  binding: GrantBinding,
  path: string,
) {
  return requestDestructiveApproval(approvals, context, binding, `Delete file ${path}`, `delete file ${path}`, "delete_file");
}

export function deleteSceneTool(
  dependencies: DestructiveToolDependencies,
): ToolDefinition<z.infer<typeof DeleteSceneInputSchema>, z.infer<typeof DeleteSceneOutputSchema>> {
  return {
    name: "delete_scene",
    title: "Delete a scene",
    level: "destructive",
    description: [
      "Use when permanently removing one scene, its mount, unique source, narration, and preview settings with a verified backup.",
      "Do not use to hide, reorder, or edit a scene, or when shared references must remain.",
      "Preconditions: sceneId and expectedRevision come from current project context; omit grantId to create an approval request, then retry once with the issued grantId.",
      "Side effects: after approval, atomically deletes owned scene artifacts, updates root duration, publishes a backup, consumes the grant, and commits one destructive revision.",
      "Errors/recovery: refresh context after write_conflict; request new approval after approval_invalid or approval_expired; on recovery_required stop and recover; never retry committed_response_error.",
    ].join(" "),
    input: DeleteSceneInputSchema,
    output: DeleteSceneOutputSchema,
    annotations: annotationsForLevel("destructive"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      if (!input.grantId) {
        const prepared = await prepareSceneDeletion(dependencies, {
          projectId: input.projectId as ProjectId,
          sceneId: input.sceneId,
          expectedRevision: input.expectedRevision,
        });
        if (!prepared.ok) return prepared;
        return requestSceneDeletionApproval(dependencies.approvals, context, prepared.value.binding, input.sceneId);
      }
      return deleteScene(dependencies, {
        projectId: input.projectId as ProjectId,
        sceneId: input.sceneId,
        expectedRevision: input.expectedRevision,
        grantId: input.grantId,
      }, context.actor, context.writeInvocation);
    },
  };
}

export function registerDeleteScene(registry: ToolRegistry, dependencies: DestructiveToolDependencies): void {
  registry.register(deleteSceneTool(dependencies));
}

export function deleteFileTool(
  dependencies: DestructiveToolDependencies,
): ToolDefinition<z.infer<typeof DeleteFileInputSchema>, z.infer<typeof DeleteFileOutputSchema>> {
  return {
    name: "delete_file",
    title: "Delete an unreferenced source file",
    level: "destructive",
    description: [
      "Use when permanently removing one allowlisted, unreferenced project-relative source.",
      "Do not use for protected files, referenced sources, directories, or scene deletion.",
      "Preconditions: path and expectedContentHash come from read_composition or current project context; omit grantId to create an approval request, then retry once with the issued grantId.",
      "Side effects: after approval, atomically deletes the file, publishes a verified backup, consumes the grant, commits one destructive revision, and returns backupId with the revision envelope.",
      "Errors/recovery: keep the file on referenced_by_composition; re-read after write_conflict; request new approval after invalid or expired approval; recover on recovery_required; never retry committed_response_error.",
    ].join(" "),
    input: DeleteFileInputSchema,
    output: DeleteFileOutputSchema,
    annotations: annotationsForLevel("destructive"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const prepared = await prepareFileDeletion(dependencies, {
        projectId: input.projectId as ProjectId,
        path: input.path as RelPath,
        expectedContentHash: input.expectedContentHash as ContentHash,
      });
      if (!prepared.ok) return prepared;
      if (!input.grantId) {
        return requestFileDeletionApproval(dependencies.approvals, context, prepared.value.binding, input.path);
      }
      return deleteFile(dependencies, {
        projectId: input.projectId as ProjectId,
        plan: prepared.value.plan,
        grantId: input.grantId,
      }, context.actor, context.writeInvocation);
    },
  };
}

export function registerDeleteFile(registry: ToolRegistry, dependencies: DestructiveToolDependencies): void {
  registry.register(deleteFileTool(dependencies));
}
