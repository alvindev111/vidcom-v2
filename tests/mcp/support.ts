import {
  type ContentHash,
  DeleteFileInputSchema,
  ErrorCode,
  GetProjectContextInputSchema,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  ok,
  ToolAuditService,
  type AbsolutePath,
  type CompositionModel,
  type CompositeRequest,
  type ProjectRef,
  type ResolvedPath,
  type ToolAuditEntry,
} from "@vidcom/core";
import {
  registerVidcomTools,
  ToolRegistry,
  type ToolDefinition,
  type VidcomToolDependencies,
} from "@vidcom/mcp";

const matrixProjectId = "project-contract-matrix" as ProjectId;
export const matrixHash = `sha256:${"1".repeat(64)}` as ContentHash;
export const matrixNewHash = `sha256:${"2".repeat(64)}` as ContentHash;

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
    grantId: "grant-contract-matrix",
  },
  delete_scene: {
    projectId: matrixProjectId,
    sceneId: "scene-1",
    expectedRevision: 2,
    grantId: "grant-contract-matrix",
  },
};

function createBaseRegistry(auditEntries: ToolAuditEntry[] = [], journalOwned = false): ToolRegistry {
  const audit = new ToolAuditService(
    { record: async (entry) => { auditEntries.push(entry); } },
    { now: () => new Date() },
    { warn: () => undefined, error: () => undefined },
    { increment: () => undefined, observeMilliseconds: () => undefined },
    { isJournalOwned: async () => journalOwned },
  );
  return new ToolRegistry({
    audit,
    approvals: { request: async () => "unused-approval" },
  });
}

/** Registers every production descriptor against a deterministic successful project harness. */
export function createContractMatrixRegistry(): ToolRegistry {
  const registry = createBaseRegistry([], true);
  const ref: ProjectRef = {
    id: matrixProjectId,
    slug: "contract-matrix",
    root: "/workspace/contract-matrix" as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  const entry = "<main data-composition-id=\"root\"></main>";
  const sceneSource = "<section data-composition-id=\"scene-1\"><h1 id=\"title\">Title</h1></section>";
  const previewSettings = `${JSON.stringify(DEFAULT_PREVIEW_SETTINGS, null, 2)}\n`;
  const files = new Map<string, string>([
    ["index.html", entry],
    ["compositions/scene-1.html", sceneSource],
    ["compositions/unused.html", "<aside>unused</aside>"],
    ["preview-settings.json", previewSettings],
  ]);
  const model: CompositionModel = {
    project: {
      id: matrixProjectId,
      slug: ref.slug,
      title: "Contract Matrix",
      width: 1920,
      height: 1080,
      duration: 8,
      updatedAt: "2026-08-02T00:00:00.000Z",
      sceneCount: 1,
      revision: 0,
    },
    scenes: [{
      id: "scene-1",
      start: 0,
      duration: 4,
      trackIndex: 1,
      src: "compositions/scene-1.html" as RelPath,
      block: null,
      isTransition: false,
      media: [],
      script: [{ id: "title", text: "Title", file: "index.html" as RelPath }],
      narration: null,
      elements: [],
      unresolvedEffects: 0,
    }],
    rootTrack: null,
    diagnostics: [],
    sources: [
      { path: "index.html" as RelPath, contentHash: matrixHash, byteSize: entry.length },
      {
        path: "compositions/scene-1.html" as RelPath,
        contentHash: matrixHash,
        byteSize: sceneSource.length,
      },
    ],
    references: [],
  };
  const dependencies = {
    workspace: {
      listProjects: async () => [ref],
      readProjectRef: async (projectId: ProjectId) => projectId === matrixProjectId ? ref : null,
      resolve: async (_ref: ProjectRef, path: RelPath) => ok(path as unknown as ResolvedPath),
      readFile: async (path: ResolvedPath) => {
        const content = files.get(path);
        return content === undefined ? null : { content, contentHash: matrixHash };
      },
      readHash: async (path: ResolvedPath) => files.has(path) ? matrixHash : null,
      stat: async (path: ResolvedPath) => files.has(path)
        ? { size: files.get(path)!.length, modifiedAt: new Date(0), kind: "file" as const }
        : null,
      readTree: async () => [
        { path: "index.html" as RelPath, name: "index.html", kind: "file" as const },
        { path: "compositions" as RelPath, name: "compositions", kind: "directory" as const },
      ],
    },
    composition: {
      parseProject: async () => model,
      applyOps: async () => ok("<main data-composition-id=\"root\"></main>"),
    },
    journal: {
      latestRevision: async () => 2,
      readEntityState: async () => ({
        revision: 1,
        contentHash: matrixHash,
        backingPath: "preview-settings.json" as RelPath,
      }),
      readProjectRecoveryStatus: async () => ({ writeStatus: "ready" as const, unresolved: [] }),
    },
    authority: {
      mutate: async () => ok({
        path: null,
        contentHash: matrixNewHash,
        revision: 3,
        diagnostics: [],
      }),
      mutateComposite: async (request: CompositeRequest) => {
        const fileHashes = Object.fromEntries(
          request.steps
            .filter((step) => step.kind === "write")
            .map((step) => [step.path, matrixNewHash]),
        ) as Record<RelPath, ContentHash>;
        return ok({
          projectRevision: 3,
          entityRevision: null,
          fileHashes,
          diagnostics: [],
          ...(request.backup ? { backupId: "backup-contract-matrix" } : {}),
        });
      },
    },
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
