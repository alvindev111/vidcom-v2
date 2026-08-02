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
    description: "Plan and delete one scene atomically, including its mount, unique source, narration, preview settings, verified backup, and root duration. Requires expectedRevision and an issued grantId; without one, creates an approval request and returns input-required/approval_required for retry.",
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
    description: "Delete one allowlisted, unreferenced project-relative source after exact content-hash planning and approval. Rejects protected or composition-referenced files; publishes a verified backup and returns deleted path, revision envelope, and backupId.",
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
