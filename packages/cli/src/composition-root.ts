import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";

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
  SqlitePendingMountStore,
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
  DOWNLOAD_CACHE_COMPONENTS,
  DownloadCacheCoordinator,
  NodeHyperframesDiagnosticsLint,
  FontkitCompatibilityInspector,
  BgmLibraryStore,
  BgmProviderRegistry,
  CcMixterBgmProvider,
  OpenverseBgmProvider,
  NodeModulesMotionLibraryFiles,
  synthesizeBgmBed,
  WorkspaceLease,
  hyperframesRuntimeSource,
  mimeFromPath,
  openVidcomDatabase,
  projectRegistrationLocationExists,
  type RuntimePaths,
} from "@vidcom/adapter";
import { DEFAULT_VIDCOM_SETTINGS, type ContentHash, type ProjectId, type ResolvedVidcomSettings } from "@vidcom/contracts";
import {
  reconcileCompositeMutation,
  bootstrapProject,
  ApprovalService,
  McpCredentialService,
  ToolAuditService,
  EntryRegistry,
  AgentKitInstaller,
  ProjectIdentityService,
  ProjectLifecycle,
  DiagnosticsService,
  FontCompatibilityService,
  ThumbnailResolver,
  ProjectStateStore,
  scanWorkspace,
  WriteAuthority,
  WorkspaceMutationCoordinator,
  ProjectCache,
  ProjectPathInvalidatorFanout,
  type AbsolutePath,
  type ClockPort,
  type IdPort,
  type LogPort,
  type MetricPort,
  type ProcessPort,
  type ProcessRunInput,
  type JobTypeDefinition,
  type ProjectRef,
} from "@vidcom/core";
import { registerVidcomTools, ToolRegistry } from "@vidcom/mcp";
import { MutationHistory } from "@vidcom/server";
import {
  createNoopProbeJobType,
  enqueueRenderJob,
  enqueueSnapshotJob,
  createRenderJobHandler,
  createSnapshotJobHandler,
  createTtsJobType,
  createProjectImportJobType,
} from "@vidcom/worker";

import { createProjectImportJobDependencies } from "./project-import-service";

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
  /**
   * Every runtime location, already resolved by `resolveRuntimePaths`.
   *
   * Supplying this is how a packaged artifact stops relying on the individual
   * optional fields below. Those fields each default to something reasonable on
   * their own, which is exactly the problem: a packaged build that forgets one
   * gets a plausible path pointing at nothing rather than an error. When this is
   * present it decides, and the resolver has already proven all five are
   * absolute and complete.
   */
  runtimePaths?: RuntimePaths;
  /**
   * Certificate bundle for child processes, from the extracted runtime.
   *
   * Reaches Node children as `NODE_EXTRA_CA_CERTS`; the sidecar receives its own
   * pair through the TTS provider.
   */
  caBundlePath?: AbsolutePath;
  /** Phase 4 extraction root for native sidecars; never inferred from the source checkout. */
  nativeDependenciesRoot?: AbsolutePath;
  /** Explicit render-sidecar paths; packaging may override the native-root convention. */
  renderBinaryPaths?: { ffmpegPath: AbsolutePath; ffprobePath: AbsolutePath };
  /**
   * Directory holding the distributed motion libraries, laid out as
   * `<packageName>/<packagePath>`. The packaged runtime must set this: it has no
   * `node_modules` to resolve, so vendoring would otherwise fail there.
   */
  motionLibraryRoot?: AbsolutePath;
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
  /** Injectable process seam for deterministic integration tests; production uses NodeProcessRunner. */
  processes?: ProcessPort;
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
  const nativeRoot = (config.runtimePaths?.nativeDependenciesRoot
    ?? config.nativeDependenciesRoot
    ?? join(config.appDataRoot, "native")) as AbsolutePath;
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  return {
    ffmpegPath: (process.env.HYPERFRAMES_FFMPEG_PATH?.trim()
      || join(nativeRoot, "bin", `ffmpeg${executableSuffix}`)) as AbsolutePath,
    ffprobePath: (process.env.HYPERFRAMES_FFPROBE_PATH?.trim()
      || join(nativeRoot, "bin", `ffprobe${executableSuffix}`)) as AbsolutePath,
  };
}

/** Resolves registry-owned FFmpeg commands through the verified runtime paths. */
export function withAudioBinaryPaths(
  processes: ProcessPort,
  binaries: { ffmpegPath: AbsolutePath; ffprobePath: AbsolutePath },
): ProcessPort {
  return {
    run(input: ProcessRunInput) {
      const [executable, ...args] = input.command;
      const mapped = executable === "ffmpeg"
        ? binaries.ffmpegPath
        : executable === "ffprobe"
          ? binaries.ffprobePath
          : executable;
      return processes.run({ ...input, command: mapped === undefined ? [] : [mapped, ...args] });
    },
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
  requirePackagedRuntime = false,
): readonly string[] {
  return settings.tts.vieneu.command
    ?? defaultVieNeuCommand(extractionRoot, requirePackagedRuntime);
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

/**
 * Offline model reads are opt-in: the first run must still be able to download
 * weights. The standard Hugging Face/Transformers flags are also what the
 * packaged-smoke offline pass can set without adding another public setting.
 */
function vieneuOffline(): boolean {
  return process.env.HF_HUB_OFFLINE === "1" || process.env.TRANSFORMERS_OFFLINE === "1";
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
  const settings = config.settings ?? DEFAULT_VIDCOM_SETTINGS;
  const caBundlePath = config.caBundlePath ?? settings.runtime.caBundlePath ?? undefined;
  const database = openVidcomDatabase(config.appDataRoot);
  const downloads = new DownloadCacheCoordinator({ cacheRoot: config.appDataRoot });
  const browserCacheRoot = (config.runtimePaths?.browserCacheRoot
    ?? downloads.componentRoot(DOWNLOAD_CACHE_COMPONENTS.browser)) as AbsolutePath;
  const workspace = new WorkspaceFs(config.workspaceRoot);
  const largeContent = new LargePreviousContentStore(config.appDataRoot);
  const mutationObserver = new MutationHistory(largeContent);
  const journal = new MutationJournal(database, clock, largeContent);
  const pendingMount = new SqlitePendingMountStore(database, clock);
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
  const renderProcess = new NodeProcessSupervisor(undefined, {
    defaultEnvironment: { VIDCOM_APP_DATA: config.appDataRoot },
    caBundlePath,
  });
  const processes = config.processes ?? new NodeProcessRunner(undefined, caBundlePath);
  const ttsProcesses = withAudioBinaryPaths(processes, binaries);
  const renderGuard = new LoopbackRuntimeAssetGuard();
  // The probe falls back to require.resolve when a path is absent, which cannot
  // work inside a packaged binary. Handing it the resolved paths is what keeps
  // that fallback off the artifact path.
  const renderBinaries = new NodeRenderBinaryProbe({
    ...binaries,
    browserCacheRoot,
    ...config.runtimePaths ? {
      hyperframesCliPath: config.runtimePaths.hyperframesCliPath as AbsolutePath,
      hyperframesPackagePath: config.runtimePaths.hyperframesPackagePath as AbsolutePath,
    } : {},
  }, {
    appDataRoot: config.appDataRoot,
    caBundlePath,
    processes,
    downloadCache: downloads,
  });
  const events = new SqliteEventOutbox(database, clock);
  const cache = new ProjectCache();
  const pathInvalidator = new ProjectPathInvalidatorFanout([cache], () => {
    logger.warn("project path invalidator consumer failed");
    metrics.increment("project_path_invalidator_error");
  });
  const writtenHashes = new WrittenHashTracker();
  const watcher = new WorkspaceWatcher(
    workspace,
    database,
    events,
    pathInvalidator,
    writtenHashes,
    clock,
    undefined,
    undefined,
    mutationObserver,
  );
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
  // The Node half of D.7. The sidecar gets `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`
  // from the TTS provider; every Node child started here gets the same bundle
  // as `NODE_EXTRA_CA_CERTS`.
  const diagnosticLint = new NodeHyperframesDiagnosticsLint(processes, {
    ...(config.runtimePaths
      ? { cliPath: config.runtimePaths.hyperframesCliPath as AbsolutePath }
      : {}),
  });
  const fontInspector = new FontkitCompatibilityInspector();
  // App-data, never the workspace or the checkout: these are engine
  // intermediates and model weights, and a project directory is watched, backed
  // up and committed by its owner.
  const ttsScratchRoot = join(config.appDataRoot, "tts-scratch");
  const tts = new TtsRegistry({
    processes: ttsProcesses,
    scratchRoot: ttsScratchRoot,
    providers: [
      new ElevenLabsTtsProvider({ apiKey: elevenLabsApiKey(settings) }),
      new VieNeuTtsProvider({
        processes: ttsProcesses,
        command: () => vieneuCommand(
          settings,
          config.runtimePaths?.nativeDependenciesRoot ?? config.nativeDependenciesRoot,
          config.runtimePaths?.mode === "artifact",
        ),
        modelCacheRoot: downloads.componentRoot(DOWNLOAD_CACHE_COMPONENTS.models),
        downloadCache: downloads,
        caBundlePath,
        offline: vieneuOffline(),
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
    downloads,
    workspace,
    largeContent,
    journal,
    pendingMount,
    mutationObserver,
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
    pathInvalidator,
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
    fontInspector,
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
    // An artifact vendors from the directory it extracted, and fails when that is
    // missing rather than substituting whatever the machine has installed. A source
    // checkout names no root: its `motionLibraryRoot` points inside app-data, where
    // nothing extracts during development, so passing it made every
    // `install_motion_library` call report the library as unavailable while the
    // pinned package sat in `node_modules`. The version pin is checked either way.
    motionLibraries: new NodeModulesMotionLibraryFiles(
      config.runtimePaths && config.runtimePaths.mode !== "artifact"
        ? undefined
        : (config.runtimePaths?.motionLibraryRoot ?? config.motionLibraryRoot) as AbsolutePath | undefined,
    ),
    bgmSynth: { render: synthesizeBgmBed },
    bgmProviders: new BgmProviderRegistry([
      new OpenverseBgmProvider(),
      new CcMixterBgmProvider(),
    ]),
    bgmLibrary: new BgmLibraryStore({
      appDataRoot: config.appDataRoot,
      // From the extracted runtime in an artifact; a checkout resolves it inside
      // the adapter package, where the audio is committed.
      ...(config.runtimePaths?.bgmAssetRoot === undefined
        ? {}
        : { shippedTrackRoot: config.runtimePaths.bgmAssetRoot }),
      // FFprobe is how a non-WAV import gets its duration; the store parses WAV
      // headers itself, so a missing probe only limits which formats import.
      probeDurationSeconds: async (file) => {
        const probed = await processes.run({
          command: [binaries.ffprobePath, "-v", "error", "-show_entries",
            "format=duration", "-of", "csv=p=0", file],
        });
        const seconds = Number(String(probed.stdout ?? "").trim());
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
      },
    }),
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
    bgmSynth: infrastructure.bgmSynth,
    bgmLibrary: infrastructure.bgmLibrary,
    bgmProviders: infrastructure.bgmProviders,
    ids: infrastructure.ids,
    workspaceRoot: infrastructure.workspaceRoot,
    diagnostics: application.diagnostics,
    agentKit: application.agentKit,
    lifecycle: application.lifecycle,
    mimeFromPath: infrastructure.mimeFromPath,
    enqueueRender: (input) => enqueueRenderJob({
      workspace: infrastructure.workspace,
      composition: infrastructure.composition,
      journal: infrastructure.journal,
      jobs: infrastructure.jobs,
      ids: infrastructure.ids,
      hashContent,
      binaries: infrastructure.renderBinaries,
      fonts: application.fonts,
      diagnostics: application.diagnostics,
    }, input),
    enqueueSnapshot: (input) => enqueueSnapshotJob({
      workspace: infrastructure.workspace,
      composition: infrastructure.composition,
      journal: infrastructure.journal,
      jobs: infrastructure.jobs,
      ids: infrastructure.ids,
      hashContent,
      binaries: infrastructure.renderBinaries,
      fonts: application.fonts,
    }, input),
  });
  return registry;
}

export function createApplication(
  infrastructure: ReturnType<typeof createInfrastructure>,
  leaseId: string,
) {
  let recoverImportedProject: ((root: AbsolutePath, slug: string) => Promise<void>) | null = null;
  const workspaceCoordinator = new WorkspaceMutationCoordinator({
    workspace: infrastructure.workspace,
    journal: infrastructure.workspaceOperations,
    lease: infrastructure.lease,
    leaseId,
    hashContent,
    directories: infrastructure.projectDirectories,
    clock: infrastructure.clock,
    recoverImportedProject: (root, slug) => {
      if (!recoverImportedProject) throw new Error("project import recovery is not initialized");
      return recoverImportedProject(root, slug);
    },
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
    pathInvalidator: infrastructure.pathInvalidator,
    writtenStates: infrastructure.writtenHashes,
    pendingMount: infrastructure.pendingMount,
    recordWrittenHash(projectId, relativePath, hash) {
      infrastructure.writtenHashes.record(projectId, relativePath, hash);
    },
    notifyEvents() {},
    clock: infrastructure.clock,
    stagedAssets: infrastructure.stagedAssets,
    workspaceCoordinator,
    backups: infrastructure.backups,
    observer: infrastructure.mutationObserver,
    undoContent: infrastructure.largeContent,
    reconcileJournal: (journalId) => reconcileCompositeMutation({
      workspace: infrastructure.workspace,
      journal: infrastructure.journal,
      resolveProjectRef: infrastructure.resolveProjectRef,
      observer: infrastructure.mutationObserver,
      clock: infrastructure.clock,
    }, journalId),
  });
  recoverImportedProject = async (root, slug) => {
    const result = await bootstrapProject({
      workspace: infrastructure.workspace,
      journal: infrastructure.journal,
      authority,
      clock: infrastructure.clock,
      ids: infrastructure.ids,
      hashContent,
      registrationLocationExists: projectRegistrationLocationExists,
    }, {
      workspaceRoot: infrastructure.workspaceRoot,
      root,
      slug,
      entry: "index.html" as import("@vidcom/contracts").RelPath,
    });
    if (!result.ok) throw new Error(result.error.message);
  };
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
    undoContent: infrastructure.largeContent,
    identity,
    motionLibraries: infrastructure.motionLibraries,
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
  const fonts = new FontCompatibilityService(infrastructure.fontInspector);
  const diagnostics = new DiagnosticsService({
    scan,
    workspace: infrastructure.workspace,
    composition: infrastructure.composition,
    identity,
    journal: infrastructure.journal,
    authority,
    lint: infrastructure.diagnosticLint,
    fonts,
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
    leaseId,
    authority,
    identity,
    state,
    lifecycle,
    diagnostics,
    fonts,
    thumbnails,
    agentKit,
    readDependencies,
    writeDependencies,
    workspaceCoordinator,
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
    createProjectImportJobType(createProjectImportJobDependencies({
      journal: infrastructure.workspaceOperations,
      leaseId: application.leaseId,
      now: () => infrastructure.clock.now().toISOString(),
      takenSlugs: async () => (await application.scanWorkspace()).map((entry) => entry.slug),
      backfill: async (target) => {
        const result = await bootstrapProject({
          workspace: infrastructure.workspace,
          journal: infrastructure.journal,
          authority: application.authority,
          clock: infrastructure.clock,
          ids: infrastructure.ids,
          hashContent,
          registrationLocationExists: projectRegistrationLocationExists,
        }, {
          workspaceRoot: infrastructure.workspaceRoot,
          root: target as AbsolutePath,
          slug: basename(target),
          entry: "index.html" as import("@vidcom/contracts").RelPath,
        });
        if (!result.ok) throw new Error(result.error.message);
      },
    })),
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
      fonts: application.fonts,
      diagnostics: application.diagnostics,
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
      fonts: application.fonts,
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
