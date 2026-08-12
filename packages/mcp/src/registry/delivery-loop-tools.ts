import type { z } from "zod";

import {
  InstallAgentKitInputSchema,
  InstallAgentKitOutputSchema,
  StartDeliveryJobOutputSchema,
  StartRenderInputSchema,
  StartSnapshotInputSchema,
  ValidateProjectInputSchema,
  ValidateProjectOutputSchema,
  type ContentHash,
  type ProjectId,
} from "@vidcom/contracts";
import {
  ok,
  type AbsolutePath,
  type AgentKitInstaller,
  type DiagnosticsService,
  type Job,
  type InstallAgentKitInput as CoreInstallAgentKitInput,
  type Result,
} from "@vidcom/core";
import type { DomainError } from "@vidcom/contracts";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export interface DeliveryLoopToolDependencies {
  workspaceRoot: AbsolutePath;
  diagnostics: DiagnosticsService;
  agentKit: AgentKitInstaller;
  hashContent(content: string | Uint8Array): ContentHash;
  enqueueRender(input: {
    projectId: ProjectId;
    bestEffort?: boolean;
    renderPresetId?: string;
    idempotencyKey?: string;
  }): Promise<Result<Job, DomainError>>;
  enqueueSnapshot(input: {
    projectId: ProjectId;
    idempotencyKey?: string;
  }): Promise<Result<Job, DomainError>>;
}

export function validateProjectTool(
  dependencies: DeliveryLoopToolDependencies,
): ToolDefinition<z.infer<typeof ValidateProjectInputSchema>, z.infer<typeof ValidateProjectOutputSchema>> {
  return {
    name: "validate_project",
    title: "Validate a VidCom project",
    level: "read",
    description: "Use when validating a project after an edit and before snapshot or render. Do not use to mutate source or to inspect rendered pixels. Preconditions: projectId comes from list_projects. Side effects: computes diagnostics and refreshes only the derived diagnostics projection; source revision is unchanged. Errors/recovery: fix every error diagnostic before continuing; no-composition is an informational result for an empty project, not a tool failure.",
    input: ValidateProjectInputSchema,
    output: ValidateProjectOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => dependencies.diagnostics.forProject(input.projectId as ProjectId),
  };
}

export function startRenderTool(
  dependencies: DeliveryLoopToolDependencies,
): ToolDefinition<z.infer<typeof StartRenderInputSchema>, z.infer<typeof StartDeliveryJobOutputSchema>> {
  return {
    name: "start_render",
    title: "Start a video render",
    level: "job",
    description: "Use when the validated, visually inspected project is ready for one MP4 render and every story beat has meaningful multi-phase motion. Do not use before validate_project and start_snapshot, to wait synchronously for completion, or when story scenes rely only on fade, gentle rise/drop, or repeated opacity-plus-translate entrances. Preconditions: projectId comes from list_projects, optional idempotencyKey must identify this exact request, and the reviewed storyboard plus scene sources must show a value-first story spine and setup/development/payoff/hold choreography. Side effects: enqueues one render job and returns immediately without publishing an artifact yet. Errors/recovery: poll get_job_status after pollAfterMs; fix stable gate errors before retrying and report warnings, outcome, and cleanupPending honestly.",
    input: StartRenderInputSchema,
    output: StartDeliveryJobOutputSchema,
    annotations: annotationsForLevel("job"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, raw) => {
      const input = {
        projectId: raw.projectId as ProjectId,
        ...(raw.bestEffort === undefined ? {} : { bestEffort: raw.bestEffort }),
        ...(raw.renderPresetId === undefined ? {} : { renderPresetId: raw.renderPresetId }),
      };
      const enqueued = await dependencies.enqueueRender({
        ...input,
        ...(raw.idempotencyKey === undefined ? {} : { idempotencyKey: raw.idempotencyKey }),
      });
      return enqueued.ok ? ok({ jobId: enqueued.value.id }) : enqueued;
    },
  };
}

export function startSnapshotTool(
  dependencies: DeliveryLoopToolDependencies,
): ToolDefinition<z.infer<typeof StartSnapshotInputSchema>, z.infer<typeof StartDeliveryJobOutputSchema>> {
  return {
    name: "start_snapshot",
    title: "Start project snapshots",
    level: "job",
    description: "Use when creating midpoint snapshots for visual inspection before final render. Do not use as a substitute for validate_project or to wait synchronously for every image. Preconditions: projectId comes from list_projects and optional idempotencyKey must identify this exact request. Side effects: enqueues one snapshot job and returns immediately without publishing frames yet. Errors/recovery: poll get_job_status after pollAfterMs; report a partial outcome and its missingSceneIds, then retry deliberately after fixing the cause.",
    input: StartSnapshotInputSchema,
    output: StartDeliveryJobOutputSchema,
    annotations: annotationsForLevel("job"),
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => {
      const projectId = input.projectId as ProjectId;
      const enqueued = await dependencies.enqueueSnapshot({
        projectId,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      return enqueued.ok ? ok({ jobId: enqueued.value.id }) : enqueued;
    },
  };
}

export function installAgentKitTool(
  dependencies: DeliveryLoopToolDependencies,
): ToolDefinition<z.infer<typeof InstallAgentKitInputSchema>, z.infer<typeof InstallAgentKitOutputSchema>> {
  return {
    name: "install_agent_kit",
    title: "Install the VidCom agent kit",
    level: "write",
    description: "Use when starting any VidCom MCP session: attempt this once before planning video work to install or refresh the workspace instructions and native skill router for the active host, and use it again when repairing that kit later. Read the installed AGENTS.md or CLAUDE.md and vidcom/SKILL.md before choosing a workflow. Do not use it to install both hosts implicitly, overwrite foreign/newer files, loop until ready, or block video work on manual_merge. Preconditions: install requires non-empty unique hosts; link is Claude-only; replace requires one manifest path and its current expectedContentHash. Side effects: writes one journaled workspace batch, or records an audited no-change when everything selected is pristine. Errors/recovery: when a foreign main file leaves the host degraded, read AGENTS.vidcom.md or CLAUDE.vidcom.md and the installed router directly, then proceed; re-read hashes after write_conflict and never invent a Codex import line.",
    input: InstallAgentKitInputSchema,
    output: InstallAgentKitOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: (context, input) => dependencies.agentKit.apply(
      dependencies.workspaceRoot,
      input as CoreInstallAgentKitInput,
      {
      actor: context.actor,
      toolAudit: context.writeInvocation.toolAudit,
      },
    ),
  };
}

export function registerDeliveryLoopTools(
  registry: ToolRegistry,
  dependencies: DeliveryLoopToolDependencies,
): void {
  registry.register(validateProjectTool(dependencies));
  registry.register(startSnapshotTool(dependencies));
  registry.register(startRenderTool(dependencies));
  registry.register(installAgentKitTool(dependencies));
}
