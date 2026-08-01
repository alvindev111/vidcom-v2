import { createHash, randomUUID } from "node:crypto";

import {
  CompositionHf,
  LegacyHyperframesProjects,
  MutationJournal,
  SqliteJobStore,
  SqliteEventOutbox,
  WrittenHashTracker,
  WorkspaceWatcher,
  AppDataAssetStager,
  WorkspaceFs,
  WorkspaceLease,
  hyperframesRuntimeSource,
  mimeFromPath,
  openVidcomDatabase,
} from "@vidcom/adapter";
import type { ContentHash } from "@vidcom/contracts";
import {
  WriteAuthority,
  ProjectCache,
  type AbsolutePath,
  type ClockPort,
  type IdPort,
} from "@vidcom/core";

export interface CompositionRootConfig {
  appDataRoot: string;
  workspaceRoot: AbsolutePath;
  /** Phase 4 extraction root for native sidecars; never inferred from the source checkout. */
  nativeDependenciesRoot?: AbsolutePath;
  clock?: ClockPort;
  ids?: IdPort;
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
  const database = openVidcomDatabase(config.appDataRoot);
  const workspace = new WorkspaceFs(config.workspaceRoot);
  const journal = new MutationJournal(database, clock);
  const lease = new WorkspaceLease(database, clock, ids);
  const jobs = new SqliteJobStore(database, clock);
  const events = new SqliteEventOutbox(database, clock);
  const cache = new ProjectCache();
  const writtenHashes = new WrittenHashTracker();
  const watcher = new WorkspaceWatcher(workspace, database, events, cache, writtenHashes, clock);
  const stagedAssets = new AppDataAssetStager(config.appDataRoot);
  const composition = new CompositionHf();
  return {
    ...config,
    clock,
    ids,
    database,
    workspace,
    journal,
    lease,
    jobs,
    events,
    cache,
    writtenHashes,
    watcher,
    stagedAssets,
    composition,
    runtimeSource: hyperframesRuntimeSource,
    mimeFromPath,
  };
}

export function createApplication(
  infrastructure: ReturnType<typeof createInfrastructure>,
  leaseId: string,
) {
  const authority = new WriteAuthority({
    workspace: infrastructure.workspace,
    journal: infrastructure.journal,
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
