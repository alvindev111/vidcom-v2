import {
  DeleteFileInputSchema,
  ErrorCode,
  GetProjectContextInputSchema,
  type ProjectId,
} from "@vidcom/contracts";
import { ToolAuditService, type ToolAuditEntry } from "@vidcom/core";
import {
  registerVidcomTools,
  ToolRegistry,
  type ToolDefinition,
  type VidcomToolDependencies,
} from "@vidcom/mcp";

const matrixProjectId = "project-contract-matrix" as ProjectId;
const matrixHash = `sha256:${"1".repeat(64)}`;

export const CONTRACT_MATRIX_CASES: Record<string, Record<string, unknown>> = {
  list_projects: {},
  get_project_context: { projectId: matrixProjectId },
  list_scenes: { projectId: matrixProjectId },
  read_composition: { projectId: matrixProjectId, path: "index.html" },
  create_scene: { projectId: matrixProjectId, title: "Scene", expectedContentHash: matrixHash },
  set_scene_timing: {
    projectId: matrixProjectId, sceneId: "scene-1", duration: 4, expectedContentHash: matrixHash,
  },
  set_text: {
    projectId: matrixProjectId,
    sceneId: "scene-1",
    file: "index.html",
    elementId: "title",
    text: "Hello",
    expectedContentHash: matrixHash,
  },
  save_file: {
    projectId: matrixProjectId,
    path: "compositions/scene-1.html",
    content: "<main />",
    expectedContentHash: matrixHash,
  },
  delete_file: {
    projectId: matrixProjectId,
    path: "compositions/unused.html",
    expectedContentHash: matrixHash,
  },
  delete_scene: { projectId: matrixProjectId, sceneId: "scene-1", expectedRevision: 0 },
};

function createBaseRegistry(auditEntries: ToolAuditEntry[] = []): ToolRegistry {
  const audit = new ToolAuditService(
    { record: async (entry) => { auditEntries.push(entry); } },
    { now: () => new Date() },
    { warn: () => undefined, error: () => undefined },
    { increment: () => undefined, observeMilliseconds: () => undefined },
    { isJournalOwned: async () => false },
  );
  return new ToolRegistry({
    audit,
    approvals: { request: async () => "unused-approval" },
  });
}

/** Registers every production descriptor against a deterministic missing-project harness. */
export function createContractMatrixRegistry(): ToolRegistry {
  const registry = createBaseRegistry();
  const dependencies = {
    workspace: {
      listProjects: async () => [],
      readProjectRef: async () => null,
    },
    composition: {},
    journal: {},
    authority: {},
    clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
    hashContent: () => matrixHash,
    approvals: { request: async () => "unused-approval" },
  } as unknown as VidcomToolDependencies;
  registerVidcomTools(registry, dependencies);
  return registry;
}

export function createTransportRegistry(auditEntries: ToolAuditEntry[] = []): ToolRegistry {
  const registry = createBaseRegistry(auditEntries);
  const echoTool: ToolDefinition<{ projectId: string }, { projectId: string }> = {
    name: "echo_project",
    title: "Echo project",
    level: "read",
    description: "Returns the supplied project identifier for transport verification.",
    input: GetProjectContextInputSchema,
    output: GetProjectContextInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => ({ ok: true, value: input }),
  };
  registry.register(echoTool);
  registry.register({
    ...echoTool,
    name: "resource_error_probe",
    title: "Resource error probe",
    description: "Returns a stable resource-missing error for transport verification.",
    handler: async () => ({
      ok: false,
      error: { code: ErrorCode.NoFile, message: "the requested composition file does not exist" },
    }),
  });
  interface ApprovalProbeInput {
    projectId: string;
    path: string;
    expectedContentHash: string;
    grantId?: string;
  }
  const approvalProbe: ToolDefinition<ApprovalProbeInput, { projectId: string }> = {
    ...echoTool,
    name: "approval_probe",
    title: "Approval probe",
    description: "Requests one approval input and completes after the modern MRTR retry.",
    level: "read",
    input: DeleteFileInputSchema as unknown as ToolDefinition<ApprovalProbeInput, { projectId: string }>["input"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    availableInLegacy: false,
    handler: async (context, input) => input.grantId
      ? { ok: true, value: { projectId: input.projectId } }
      : context.requestInput({
          message: "Approve the transport probe.",
          requestState: "approval-request-1",
          schema: {
            type: "object",
            properties: { grantId: { type: "string" } },
            required: ["grantId"],
            additionalProperties: false,
          },
        }),
  };
  registry.register(approvalProbe);
  return registry;
}
