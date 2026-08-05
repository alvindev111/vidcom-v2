import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { AGENT_KIT_FILES, AGENT_KIT_VERSION } from "@vidcom/agent-kit";
import {
  defaultVieNeuCommand,
  ElevenLabsTtsProvider,
  NodeProcessRunner,
  TtsRegistry,
  VieNeuTtsProvider,
  CompositionHf,
  LargePreviousContentStore,
  LegacyHyperframesProjects,
  MutationJournal,
  WorkspaceOperationJournal,
  SqliteJobStore,
  SqliteEventOutbox,
  WrittenHashTracker,
  WorkspaceWatcher,
  AppDataAssetStager,
  AppDataBackupStore,
  SqliteApprovalGrantStore,
  SqliteMcpCredentialStore,
  SqliteToolAuditRepository,
  NodeMcpCredentialCrypto,
  WorkspaceFs,
  FsProjectDirectoryAdapter,
  FsRenderProjectAdapter,
  FsRenderRootAdapter,
  injectRuntimeAssetGuardDocument,
  LoopbackRuntimeAssetGuard,
  NodeProcessSupervisor,
  NodeRenderBinaryProbe,
  NodeHyperframesDiagnosticsLint,
  WorkspaceLease,
  hyperframesRuntimeSource,
  mimeFromPath,
  openVidcomDatabase,
} from "@vidcom/adapter";
import { DEFAULT_VIDCOM_SETTINGS, type ContentHash, type ProjectId, type ResolvedVidcomSettings } from "@vidcom/contracts";
import {
  reconcileCompositeMutation,
  ApprovalService,
  McpCredentialService,
  ToolAuditService,
  EntryRegistry,
  AgentKitInstaller,
  ProjectIdentityService,
  ProjectLifecycle,
  DiagnosticsService,
  ThumbnailResolver,
  ProjectStateStore,
  scanWorkspace,
  WriteAuthority,
  WorkspaceMutationCoordinator,
  ProjectCache,
  type AbsolutePath,
  type ClockPort,
  type IdPort,
  type LogPort,
  type MetricPort,
  type JobTypeDefinition,
  type ProjectRef,
} from "@vidcom/core";
import { registerVidcomTools, ToolRegistry } from "@vidcom/mcp";
import {
  createNoopProbeJobType,
  enqueueRenderJob,
  enqueueSnapshotJob,
  createRenderJobHandler,
  createSnapshotJobHandler,
  createTtsJobType,
} from "@vidcom/worker";

export interface McpRuntimeConfig {
  approvalRequestTtlMs: number;
  approvalGrantTtlMs: number;
  approvalRetentionMs: number;
  backupPayloadRetentionMs: number;
  backupOrphanGraceMs: number;
  credentialRotationOverlapMs: number;
}

export const DEFAULT_MCP_RUNTIME_CONFIG: McpRuntimeConfig = {
  approvalRequestTtlMs: 10 * 60 * 1_000,
  approvalGrantTtlMs: 5 * 60 * 1_000,
  approvalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  backupPayloadRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  backupOrphanGraceMs: 24 * 60 * 60 * 1_000,
  credentialRotationOverlapMs: 5 * 60 * 1_000,
};

export interface CompositionRootConfig {
  appDataRoot: string;
  workspaceRoot: AbsolutePath;
  /** Phase 4 extraction root for native sidecars; never inferred from the source checkout. */
  nativeDependenciesRoot?: AbsolutePath;
  /** Explicit render-sidecar paths; packaging may override the native-root convention. */
  renderBinaryPaths?: { ffmpegPath: AbsolutePath; ffprobePath: AbsolutePath };
  /**
   * User configuration from `~/.vidcom/setting.json`, already resolved.
   *
   * Passed in rather than read here: the file may declare `appDataRoot`, so
   * whoever computes that has to have read it first. Omitting it runs on
   * defaults, which is what the tests that do not care about configuration want.
   */
  settings?: ResolvedVidcomSettings;
  clock?: ClockPort;
  ids?: IdPort;
  runtimeConfig?: Partial<McpRuntimeConfig>;
  logger?: LogPort;
  metrics?: MetricPort;
}

export function createSystemClock(): ClockPort {
  return { now: () => new Date() };
}

function renderBinaryPaths(config: CompositionRootConfig): {
  ffmpegPath: AbsolutePath;
  ffprobePath: AbsolutePath;
} {
  if (config.renderBinaryPaths) return config.renderBinaryPaths;
  const nativeRoot = config.nativeDependenciesRoot ?? join(config.appDataRoot, "native") as AbsolutePath;
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  return {
    ffmpegPath: (process.env.HYPERFRAMES_FFMPEG_PATH?.trim()
      || join(nativeRoot, "bin", `ffmpeg${executableSuffix}`)) as AbsolutePath,
    ffprobePath: (process.env.HYPERFRAMES_FFPROBE_PATH?.trim()
      || join(nativeRoot, "bin", `ffprobe${executableSuffix}`)) as AbsolutePath,
  };
}

export function createRuntimeIds(): IdPort {
  return { newId: (prefix) => `${prefix}_${randomUUID()}` };
}

export function hashContent(content: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
}

/**
 * How to invoke the VieNeu sidecar: the command from `~/.vidcom/setting.json`, or
 * the shipped worker under the ambient interpreter.
 *
 * Configurable because the sidecar needs a virtualenv with torch in it, and the
 * `python` on PATH is rarely that one.
 */
function vieneuCommand(
  settings: ResolvedVidcomSettings,
  extractionRoot?: string,
): readonly string[] {
  return settings.tts.vieneu.command ?? defaultVieNeuCommand(extractionRoot);
}

/**
 * The ElevenLabs key, from the environment first and the settings file second.
 *
 * Environment wins so CI and a one-off run never have to write the key to disk,
 * and so an operator can override a stale file without editing it.
 */
function elevenLabsApiKey(settings: ResolvedVidcomSettings): string | null {
  return process.env.ELEVENLABS_API_KEY?.trim() || settings.tts.elevenlabs.apiKey || null;
}

/** The sole production wiring point for concrete filesystem, SQLite and HyperFrames adapters. */
export function createInfrastructure(config: CompositionRootConfig) {
  const clock = config.clock ?? createSystemClock();
  const ids = config.ids ?? createRuntimeIds();
  const runtimeConfig = { ...DEFAULT_MCP_RUNTIME_CONFIG, ...config.runtimeConfig };
  const logger = config.logger ?? {
    warn: (message: string, detail?: Record<string, unknown>) =>
      process.stderr.write(`${JSON.stringify({ level: "warn", message, detail })}\n`),
    error: (message: string, detail?: Record<string, unknown>) =>
      process.stderr.write(`${JSON.stringify({ level: "error", message, detail })}\n`),
  };
  const metrics = config.metrics ?? {
    increment() {},
    observeMilliseconds() {},
  };
  const database = openVidcomDatabase(config.appDataRoot);
  const workspace = new WorkspaceFs(config.workspaceRoot);
  const largeContent = new LargePreviousContentStore(config.appDataRoot);
  const journal = new MutationJournal(database, clock, largeContent);
  const workspaceOperations = new WorkspaceOperationJournal(database, clock, largeContent);
  const lease = new WorkspaceLease(database, clock, ids);
  const jobs = new SqliteJobStore(database, clock);
  const entries = new EntryRegistry(ids);
  const binaries = renderBinaryPaths(config);
  const renderRoots = new FsRenderRootAdapter({
    stagingRoot: join(config.appDataRoot, "render-roots") as AbsolutePath,
    ...binaries,
    clock,
  });
  const renderProjects = new FsRenderProjectAdapter();
  const renderProcess = new NodeProcessSupervisor();
  const renderGuard = new LoopbackRuntimeAssetGuard();
  const renderBinaries = new NodeRenderBinaryProbe(binaries);
  const events = new SqliteEventOutbox(database, clock);
  const cache = new ProjectCache();
  const writtenHashes = new WrittenHashTracker();
  const watcher = new WorkspaceWatcher(workspace, database, events, cache, writtenHashes, clock);
  const stagedAssets = new AppDataAssetStager(config.appDataRoot);
  const backups = new AppDataBackupStore(config.appDataRoot, database, clock, ids);
  const composition = new CompositionHf();
  const grants = new SqliteApprovalGrantStore(database);
  const approvals = new ApprovalService({
    grants,
    clock,
    ids,
    config: {
      requestTtlMs: runtimeConfig.approvalRequestTtlMs,
      grantTtlMs: runtimeConfig.approvalGrantTtlMs,
    },
  });
  const credentialStore = new SqliteMcpCredentialStore(database);
  const credentials = new McpCredentialService({
    credentials: credentialStore,
    crypto: new NodeMcpCredentialCrypto(),
    clock,
    ids,
    config: { rotationOverlapMs: runtimeConfig.credentialRotationOverlapMs },
  });
  const settings = config.settings ?? DEFAULT_VIDCOM_SETTINGS;
  const processes = new NodeProcessRunner();
  const diagnosticLint = new NodeHyperframesDiagnosticsLint(processes);
  // App-data, never the workspace or the checkout: these are engine
  // intermediates and model weights, and a project directory is watched, backed
  // up and committed by its owner.
  const ttsScratchRoot = join(config.appDataRoot, "tts-scratch");
  const tts = new TtsRegistry({
    processes,
    scratchRoot: ttsScratchRoot,
    providers: [
      new ElevenLabsTtsProvider({ apiKey: elevenLabsApiKey(settings) }),
      new VieNeuTtsProvider({
        processes,
        command: () => vieneuCommand(settings, config.nativeDependenciesRoot),
        modelCacheRoot: join(config.appDataRoot, "models"),
        modelRevision: settings.tts.vieneu.modelRevision,
      }),
    ],
  });
  const toolAudit = new ToolAuditService(
    new SqliteToolAuditRepository(database),
    clock,
    logger,
    metrics,
    {
      latestRevision: journal.latestRevision.bind(journal),
      async isJournalOwned(invocationId) {
        return await journal.isJournalOwned(invocationId)
          || await workspaceOperations.isJournalOwned(invocationId);
      },
    },
  );
  const resolveProjectRef = async (projectId: ProjectId): Promise<ProjectRef | null> => {
    return workspace.readProjectRef(projectId);
  };
  return {
    ...config,
    runtimeConfig,
    clock,
    ids,
    database,
    workspace,
    largeContent,
    journal,
    workspaceOperations,
    projectDirectories: new FsProjectDirectoryAdapter(config.workspaceRoot),
    lease,
    jobs,
    entries,
    renderRoots,
    renderProjects,
    renderProcess,
    renderGuard,
    renderBinaries,
    events,
    cache,
    writtenHashes,
    watcher,
    stagedAssets,
    backups,
    composition,
    grants,
    credentialStore,
    credentials,
    settings,
    processes,
    diagnosticLint,
    tts,
    ttsScratchRoot,
    toolAudit,
    logger,
    metrics,
    approvalRequests: { request: approvals.request.bind(approvals) },
    approvalAdmin: {
      issue: approvals.issue.bind(approvals),
      revoke: approvals.revoke.bind(approvals),
      cleanupTerminal: approvals.cleanupTerminal.bind(approvals),
    },
    approvalPlanner: { planReserve: approvals.planReserve.bind(approvals) },
    resolveProjectRef,
    runtimeSource: hyperframesRuntimeSource,
    mimeFromPath,
  };
}

/** Builds the sole production Tool Registry from the initialized application capabilities. */
export function createMcpRegistry(
  infrastructure: ReturnType<typeof createInfrastructure>,
  application: ReturnType<typeof createApplication>,
): ToolRegistry {
  const registry = new ToolRegistry({
    audit: infrastructure.toolAudit,
    approvals: infrastructure.approvalRequests,
  });
  registerVidcomTools(registry, {
    ...application.writeDependencies,
    approvals: infrastructure.approvalRequests,
    hashContent,
    reads: application.readDependencies,
    jobs: infrastructure.jobs,
    tts: infrastructure.tts,
    ids: infrastructure.ids,
    workspaceRoot: infrastructure.workspaceRoot,
    diagnostics: application.diagnostics,
    agentKit: application.agentKit,
    enqueueRender: (input) => enqueueRenderJob({
      workspace: infrastructure.workspace,
      composition: infrastructure.composition,
      journal: infrastructure.journal,
      jobs: infrastructure.jobs,
      ids: infrastructure.ids,
      hashContent,
      binaries: infrastructure.renderBinaries,
    }, input),
    enqueueSnapshot: (input) => enqueueSnapshotJob({
      workspace: infrastructure.workspace,
      composition: infrastructure.composition,
      journal: infrastructure.journal,
      jobs: infrastructure.jobs,
      ids: infrastructure.ids,
      hashContent,
      binaries: infrastructure.renderBinaries,
    }, input),
  });
  return registry;
}

export function createApplication(
  infrastructure: ReturnType<typeof createInfrastructure>,
  leaseId: string,
) {
  const workspaceCoordinator = new WorkspaceMutationCoordinator({
    workspace: infrastructure.workspace,
    journal: infrastructure.workspaceOperations,
    lease: infrastructure.lease,
    leaseId,
    hashContent,
    directories: infrastructure.projectDirectories,
    clock: infrastructure.clock,
  });
  const authority = new WriteAuthority({
    workspace: infrastructure.workspace,
    journal: infrastructure.journal,
    compositeJournal: infrastructure.journal,
    lease: infrastructure.lease,
    leaseId,
    hashContent,
    validateFileContent(path, content) {
      return typeof content === "string"
        ? infrastructure.composition.validateSource?.(path, content) ?? Promise.resolve({ ok: true as const, value: undefined })
        : Promise.resolve({ ok: true as const, value: undefined });
    },
    invalidate(projectId) { infrastructure.cache.invalidate(projectId); },
    recordWrittenHash(projectId, relativePath, hash) {
      infrastructure.writtenHashes.record(projectId, relativePath, hash);
    },
    notifyEvents() {},
    stagedAssets: infrastructure.stagedAssets,
    workspaceCoordinator,
    backups: infrastructure.backups,
    reconcileJournal: (journalId) => reconcileCompositeMutation({
      workspace: infrastructure.workspace,
      journal: infrastructure.journal,
      resolveProjectRef: infrastructure.resolveProjectRef,
    }, journalId),
  });
  const readDependencies = {
    workspace: infrastructure.workspace,
    composition: infrastructure.composition,
    journal: infrastructure.journal,
    cache: infrastructure.cache,
  };
  const identity = new ProjectIdentityService({
    workspace: infrastructure.workspace,
    authority,
    composition: infrastructure.composition,
    clock: infrastructure.clock,
  });
  const writeDependencies = {
    ...readDependencies,
    authority,
    clock: infrastructure.clock,
    identity,
  };
  const state = new ProjectStateStore({
    workspace: infrastructure.workspace,
    authority,
    journal: infrastructure.journal,
    jobs: infrastructure.jobs,
    clock: infrastructure.clock,
    actor: "system",
  });
  const lifecycle = new ProjectLifecycle({
    workspaceRoot: infrastructure.workspaceRoot,
    workspace: infrastructure.workspace,
    authority,
    backups: infrastructure.backups,
    jobs: infrastructure.jobs,
    entries: infrastructure.entries,
    identity,
    composition: infrastructure.composition,
    ids: infrastructure.ids,
    clock: infrastructure.clock,
    registrations: infrastructure.journal,
    approvals: infrastructure.approvalPlanner,
    hashContent,
  });
  const scan = () => scanWorkspace({
    workspace: infrastructure.workspace,
    identity,
    entries: infrastructure.entries,
    composition: infrastructure.composition,
  }, infrastructure.workspaceRoot);
  const diagnostics = new DiagnosticsService({
    scan,
    workspace: infrastructure.workspace,
    composition: infrastructure.composition,
    identity,
    journal: infrastructure.journal,
    authority,
    lint: infrastructure.diagnosticLint,
  });
  const thumbnails = new ThumbnailResolver(infrastructure.workspace);
  const agentKit = new AgentKitInstaller({
    workspace: infrastructure.workspace,
    authority,
    actor: "user",
    bundle: {
      version: AGENT_KIT_VERSION,
      files: AGENT_KIT_FILES as unknown as Record<string, { content: string; contentHash: ContentHash }>,
    },
  });
  return {
    authority,
    identity,
    state,
    lifecycle,
    diagnostics,
    thumbnails,
    agentKit,
    readDependencies,
    writeDependencies,
    scanWorkspace: scan,
    async openProject(projectId: ProjectId) {
      const ref = await infrastructure.workspace.readProjectRef(projectId);
      if (!ref) return null;
      const backfilled = await identity.backfillPlatform(ref);
      if (!backfilled.ok) return backfilled;
      await state.ensure(ref);
      await state.reconcile(ref);
      return { ok: true as const, value: { ref, identity: backfilled.value } };
    },
  };
}

/**
 * Every job type this runtime can execute, bound to live application dependencies.
 *
 * One place, so the daemon and `vidcom mcp` cannot drift into supporting
 * different job types — a job enqueued by one and picked up by the other would
 * otherwise sit in the queue forever.
 */
export function createJobTypes(
  infrastructure: ReturnType<typeof createInfrastructure>,
  application: ReturnType<typeof createApplication>,
): JobTypeDefinition[] {
  return [
    createNoopProbeJobType(),
    createTtsJobType({
      dependencies: { ...application.writeDependencies, tts: infrastructure.tts },
      actor: "user",
    }),
    createRenderJobHandler({
      process: infrastructure.renderProcess,
      roots: infrastructure.renderRoots,
      renderProjects: infrastructure.renderProjects,
      authority: application.authority,
      composition: infrastructure.composition,
      workspace: infrastructure.workspace,
      journal: infrastructure.journal,
      guard: infrastructure.renderGuard,
      binaries: infrastructure.renderBinaries,
      runtimeSource: infrastructure.runtimeSource,
      injectGuard: injectRuntimeAssetGuardDocument,
      clock: infrastructure.clock,
      actor: "user",
    }),
    createSnapshotJobHandler({
      process: infrastructure.renderProcess,
      roots: infrastructure.renderRoots,
      renderProjects: infrastructure.renderProjects,
      authority: application.authority,
      composition: infrastructure.composition,
      workspace: infrastructure.workspace,
      journal: infrastructure.journal,
      jobs: infrastructure.jobs,
      guard: infrastructure.renderGuard,
      binaries: infrastructure.renderBinaries,
      runtimeSource: infrastructure.runtimeSource,
      injectGuard: injectRuntimeAssetGuardDocument,
      clock: infrastructure.clock,
      actor: "user",
    }),
  ];
}

/** Temporary Next compatibility wiring; removed with the legacy modules in Phase N. */
export function createLegacyCompatibility(projectsRoot: string) {
  return {
    projects: new LegacyHyperframesProjects(projectsRoot),
    composition: new CompositionHf(),
  };
}
