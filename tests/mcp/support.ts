import {
  type BgmProviderTrack,
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
  type MotionLibrary,
  type MutationRequest,
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
/** Stands in for a track a person copied into the project by hand. */
export const matrixBgmPath = "preview-assets/bgm/theme.mp3";
export const matrixRenderPath = "renders/contract-matrix.mp4";
/** One library entry, so the matrix exercises the library branch and not just the beds. */
export const matrixBgmEntry = {
  id: "bgm_matrix",
  name: "theme.mp3",
  source: "import" as const,
  bedId: null,
  durationSeconds: 30,
  byteSize: 24_467,
  contentHash: `sha256:${"3".repeat(64)}`,
  license: { kind: "own-work" as const, holder: "Contract Matrix", url: null, note: null },
  addedAt: "2026-08-02T00:00:00.000Z",
};
export const matrixBgmProviderTrack: BgmProviderTrack = {
  providerId: "matrix-music",
  trackId: "matrix-calm",
  title: "Calm matrix score",
  creator: "Contract Matrix",
  durationSeconds: 90,
  extension: "mp3",
  license: {
    kind: "cc-by",
    holder: "Contract Matrix",
    url: "https://example.test/licenses/by",
    note: null,
  },
  sourceUrl: "https://example.test/tracks/matrix-calm",
  attribution: "Calm matrix score by Contract Matrix, CC BY.",
  tags: ["calm", "instrumental"],
};
const matrixBgmProviderEntry = {
  id: "bgm_matrix_remote",
  name: "Calm matrix score.mp3",
  source: "provider" as const,
  bedId: null,
  durationSeconds: 90,
  byteSize: 4,
  contentHash: `sha256:${"4".repeat(64)}`,
  license: matrixBgmProviderTrack.license,
  provenance: {
    providerId: matrixBgmProviderTrack.providerId,
    trackId: matrixBgmProviderTrack.trackId,
    sourceUrl: matrixBgmProviderTrack.sourceUrl,
    attribution: matrixBgmProviderTrack.attribution,
  },
  addedAt: "2026-08-02T00:00:00.000Z",
};

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
  list_tts_voices: { projectId: matrixProjectId },
  start_tts: {
    projectId: matrixProjectId,
    sceneIds: ["scene-1"],
    providerId: "matrix-tts",
    voiceId: "matrix-voice",
  },
  get_job_status: { jobId: "job_matrix" },
  validate_project: { projectId: matrixProjectId },
  start_snapshot: { projectId: matrixProjectId },
  start_render: { projectId: matrixProjectId, bestEffort: true },
  install_agent_kit: { operation: "install", hosts: ["codex"] },
  install_motion_library: { projectId: matrixProjectId, libraryId: "gsap" },
  create_project: { name: "Matrix Two", presetId: "vertical-shorts" },
  adopt_project: { slug: "contract-matrix-candidate" },
  rename_project: { projectId: matrixProjectId, name: "Contract Matrix Renamed" },
  delete_project: { projectId: matrixProjectId, confirmed: true, grantId: "grant-contract-matrix" },
  list_project_assets: { projectId: matrixProjectId, directory: "preview-assets/bgm" },
  set_preview_settings: {
    projectId: matrixProjectId,
    patch: { bgm: { enabled: true, track: { name: "theme.mp3", path: matrixBgmPath } } },
    expectedRevision: 1,
  },
  get_narration_cues: { projectId: matrixProjectId, sceneId: "scene-1" },
  replace_narration_cues: {
    projectId: matrixProjectId,
    sceneId: "scene-1",
    cues: [{ cueId: "scene-1", text: "Xin chào", voice: "matrix-voice", offsetSeconds: 0 }],
    expectedContentHash: matrixHash,
  },
  patch_narration_cue: {
    projectId: matrixProjectId,
    sceneId: "scene-1",
    cueId: "scene-1",
    text: "Chào bạn",
    expectedContentHash: matrixHash,
  },
  cancel_job: { jobId: "job_matrix" },
  get_render_output: { jobId: "job_render" },
  list_bgm_beds: {},
  search_bgm: { mood: "calm focused", limit: 4 },
  install_bgm: {
    projectId: matrixProjectId,
    providerTrack: { providerId: "matrix-music", trackId: "matrix-calm" },
    expectedRevision: 1,
  },
  import_bgm: {
    projectId: matrixProjectId,
    path: matrixBgmPath,
    name: "theme.mp3",
    license: { kind: "own-work", holder: "Contract Matrix", url: null, note: null },
  },
  record_bgm_license: {
    trackId: "corporate-synth",
    license: { kind: "cc-by", holder: "Contract Matrix", url: "https://example.test/track", note: null },
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
    // The scene has narration, so its sidecar must exist: set_text marks that
    // sidecar stale and fails outright if it cannot read it.
    ["narration/scene-1.json", `${JSON.stringify({
      sceneId: "scene-1",
      text: "Xin chào",
      voice: "matrix-voice",
      status: "mock",
      audioPath: "narration/scene-1.wav",
      revision: 0,
      updatedAt: "2026-08-02T00:00:00.000Z",
      staleSince: null,
    })}\n`],
    // Neither file was written through a tool: they stand for media dropped into
    // the project directory and an artifact a render left behind.
    [matrixBgmPath, "ID3 contract matrix"],
    [matrixRenderPath, "mp4 contract matrix"],
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
      // start_tts requires narration text to exist, so the matrix scene carries
      // one; without it the tool would only ever exercise its rejection path.
      narration: {
        sceneId: "scene-1",
        text: "Xin chào",
        voice: "matrix-voice",
        status: "mock" as const,
        audioPath: "narration/scene-1.wav" as RelPath,
        command: "",
        revision: 0,
        updatedAt: "2026-08-02T00:00:00.000Z",
        staleSince: null,
      },
      elements: [{
        id: "hero",
        label: "Hero",
        kind: "element",
        start: null,
        duration: null,
        src: null,
        effects: [
          { id: "build", method: "fromTo", start: 0.2, duration: 0.6, ease: "expo.out", propertyGroup: "scale" },
          { id: "payoff", method: "to", start: 1.4, duration: 0.8, ease: "sine.inOut", propertyGroup: "rotation" },
        ],
      }],
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
      // import_bgm reads the asset's bytes, not its text.
      readBytes: async (path: ResolvedPath) => {
        const content = files.get(path);
        return content === undefined
          ? null
          : { bytes: new TextEncoder().encode(content), contentHash: matrixHash };
      },
      stat: async (path: ResolvedPath) => files.has(path)
        ? { size: files.get(path)!.length, modifiedAt: new Date(0), kind: "file" as const }
        : null,
      exists: async (path: ResolvedPath) => files.has(path),
      readTree: async () => [
        { path: "index.html" as RelPath, name: "index.html", kind: "file" as const },
        { path: "compositions" as RelPath, name: "compositions", kind: "folder" as const, children: [
          { path: "compositions/scene-1.html" as RelPath, name: "scene-1.html", kind: "file" as const },
        ] },
        { path: "preview-assets" as RelPath, name: "preview-assets", kind: "folder" as const, children: [
          { path: matrixBgmPath as RelPath, name: "theme.mp3", kind: "file" as const },
        ] },
        { path: "renders" as RelPath, name: "renders", kind: "folder" as const, children: [
          { path: matrixRenderPath as RelPath, name: "contract-matrix.mp4", kind: "file" as const },
        ] },
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
      // install_bgm rides the staged-asset + preview-settings mutation, so the
      // matrix needs that seam too, not only mutateSource.
      uploadBgm: async () => ok({
        path: null,
        contentHash: matrixNewHash,
        revision: 3,
        diagnostics: [],
        previewSettings: DEFAULT_PREVIEW_SETTINGS,
      }),
      mutateSource: async (request: CompositeRequest | MutationRequest) => {
        if (!("steps" in request)) {
          return ok({
            path: request.kind === "file" ? request.path : null,
            contentHash: matrixNewHash,
            revision: 3,
            diagnostics: [],
            ...(request.kind === "entity" ? { previewSettings: DEFAULT_PREVIEW_SETTINGS } : {}),
          });
        }
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
    tts: {
      listProviders: async () => [{
        id: "matrix-tts",
        label: "Matrix TTS",
        available: true,
        unavailableReason: null,
        voices: [{
          id: "matrix-voice",
          providerId: "matrix-tts",
          label: "Matrix voice",
          language: "vi",
          modelId: "matrix-1",
          supportsEmotionCues: false,
          computeDevices: ["cpu"],
          recommended: true,
        }],
        allowsCustomVoiceId: false,
        customVoiceDefaults: null,
      }],
      synthesize: async () => ok([]),
    },
    jobs: {
      enqueue: async (job: { id: string }) => ({
        job: {
          ...job,
          status: "queued",
          progress: 0,
          stage: null,
          result: null,
          error: null,
          warnings: null,
          cleanupPending: false,
          attempt: 0,
          createdAt: "2026-08-02T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        },
        reused: false,
      }),
      requestCancel: async () => undefined,
      get: async (id: string) => id === "job_render" ? {
        id: "job_render",
        projectId: matrixProjectId,
        type: "render",
        status: "succeeded" as const,
        progress: 1,
        stage: null,
        result: { artifactPath: matrixRenderPath, revision: 3 },
        error: null,
        warnings: null,
        cleanupPending: false,
        attempt: 1,
        createdAt: "2026-08-02T00:00:00.000Z",
        startedAt: "2026-08-02T00:00:01.000Z",
        finishedAt: "2026-08-02T00:00:02.000Z",
      } : {
        id: "job_matrix",
        type: "tts",
        status: "succeeded" as const,
        progress: 1,
        stage: null,
        result: { assets: [], revision: 3 },
        error: null,
        warnings: null,
        cleanupPending: false,
        attempt: 1,
        createdAt: "2026-08-02T00:00:00.000Z",
        startedAt: "2026-08-02T00:00:01.000Z",
        finishedAt: "2026-08-02T00:00:02.000Z",
      },
    },
    ids: { newId: (prefix: string) => `${prefix}_matrix` },
    workspaceRoot: "/workspace" as AbsolutePath,
    mimeFromPath: () => "video/mp4",
    bgmSynth: { render: () => new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]) },
    bgmLibrary: {
      list: async () => [matrixBgmEntry],
      hasShipped: async () => true,
      readShipped: async () => new Uint8Array([73, 68, 51, 4]),
      shippedLicenses: async () => ({}),
      recordShippedLicense: async () => undefined,
      read: async () => new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
      add: async (input: { source: string }) => ok({
        entry: input.source === "provider" ? matrixBgmProviderEntry : matrixBgmEntry,
        alreadyPresent: false,
      }),
    },
    bgmProviders: {
      search: async () => ({
        tracks: [matrixBgmProviderTrack],
        providers: [{
          providerId: "matrix-music",
          status: "ok" as const,
          resultCount: 1,
          message: null,
        }],
      }),
      download: async () => ok({
        track: matrixBgmProviderTrack,
        bytes: new Uint8Array([73, 68, 51, 4]),
      }),
    },
    lifecycle: {
      create: async () => ok({ projectId: "project_matrix" as ProjectId, slug: "matrix-two" }),
      adopt: async () => ok({ projectId: "project_matrix" as ProjectId }),
      rename: async () => ok({ slug: "contract-matrix-renamed" }),
      planRemove: async () => ok({
        binding: {
          tool: "delete_project",
          projectId: matrixProjectId,
          target: matrixProjectId,
          expectedRevision: 2,
          targetHashes: { ["index.html" as RelPath]: matrixHash },
          planDigest: matrixHash,
        },
        summary: "Delete project contract-matrix",
      }),
      remove: async () => ok({ backupId: "backup-contract-matrix" }),
    },
    diagnostics: {
      forProject: async () => ok({
        diagnostics: [],
        computedAtSourceRevision: 2,
        lintSourceAvailable: true,
      }),
    },
    motionLibraries: {
      read: async (library: MotionLibrary) => ok(library.files.map(({ projectPath }) => ({
        projectPath,
        content: "/* contract matrix motion library */\n",
      }))),
    },
    agentKit: {
      apply: async () => ok({
        operationResult: { status: "no_change", changedFiles: [] },
        installationState: {
          outcome: "already_installed",
          files: [],
          usableBy: { codex: "ready" },
          recovery: [{ host: "codex", action: "none", detail: "VidCom agent kit is current." }],
        },
      }),
    },
    enqueueRender: async () => ok({
      id: "job_render",
      projectId: matrixProjectId,
      type: "render",
      status: "queued" as const,
      progress: 0,
      stage: null,
      result: null,
      error: null,
      warnings: null,
      cleanupPending: false,
      terminationProof: null,
      attempt: 0,
      input: {},
      inputHash: matrixHash,
      idempotencyKey: null,
      cancelRequested: false,
      workerId: null,
      heartbeatAt: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    }),
    enqueueSnapshot: async () => ok({
      id: "job_snapshot",
      projectId: matrixProjectId,
      type: "snapshot",
      status: "queued" as const,
      progress: 0,
      stage: null,
      result: null,
      error: null,
      warnings: null,
      cleanupPending: false,
      terminationProof: null,
      attempt: 0,
      input: {},
      inputHash: matrixHash,
      idempotencyKey: null,
      cancelRequested: false,
      workerId: null,
      heartbeatAt: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    }),
  } as unknown as VidcomToolDependencies;
  // The read dependencies are the same fakes the write tools use, so the job
  // tools see the identical project rather than a second, divergent harness.
  dependencies.reads = dependencies;
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
