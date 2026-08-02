import { createHash, randomUUID } from "node:crypto";

import {
  CompositionHf,
  LargePreviousContentStore,
  LegacyHyperframesProjects,
  MutationJournal,
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
  WorkspaceLease,
  hyperframesRuntimeSource,
  mimeFromPath,
  openVidcomDatabase,
} from "@vidcom/adapter";
import type { ContentHash, ProjectId } from "@vidcom/contracts";
import {
  reconcileCompositeMutation,
  ApprovalService,
  McpCredentialService,
  ToolAuditService,
  WriteAuthority,
  ProjectCache,
  type AbsolutePath,
  type ClockPort,
  type IdPort,
  type LogPort,
  type MetricPort,
  type ProjectRef,
} from "@vidcom/core";
import { registerVidcomTools, ToolRegistry } from "@vidcom/mcp";

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
  clock?: ClockPort;
  ids?: IdPort;
  runtimeConfig?: Partial<McpRuntimeConfig>;
  logger?: LogPort;
  metrics?: MetricPort;
}

export function createSystemClock(): ClockPort {
  return { now: () => new Date() };
}

export function createRuntimeIds(): IdPort {
  return { newId: (prefix) => `${prefix}_${randomUUID()}` };
}

export function hashContent(content: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
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
  const lease = new WorkspaceLease(database, clock, ids);
  const jobs = new SqliteJobStore(database, clock);
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
  const toolAudit = new ToolAuditService(
    new SqliteToolAuditRepository(database),
    clock,
    logger,
    metrics,
    journal,
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
    lease,
    jobs,
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
    toolAudit,
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
  });
  return registry;
}

export function createApplication(
  infrastructure: ReturnType<typeof createInfrastructure>,
  leaseId: string,
) {
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
  const writeDependencies = {
    ...readDependencies,
    authority,
    clock: infrastructure.clock,
  };
  return { authority, readDependencies, writeDependencies };
}

/** Temporary Next compatibility wiring; removed with the legacy modules in Phase N. */
export function createLegacyCompatibility(projectsRoot: string) {
  return {
    projects: new LegacyHyperframesProjects(projectsRoot),
    composition: new CompositionHf(),
  };
}
