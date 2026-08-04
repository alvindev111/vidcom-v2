import {
  type Actor,
  type ErrorCode,
  type JobStatus,
  type ProjectId,
  type RelPath,
  type DomainError,
  type Diagnostic,
} from "@vidcom/contracts";

import type { PlatformConfig } from "../domain/platform-preset";
import type { ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { ClockPort, JobStorePort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { Job, ProjectRevisionProjection } from "../port/types";
import { canonicalizeJson } from "./canonical-json";
import { type DerivedMutationPath, type WriteAuthority } from "./write-authority";

export type ProjectContentState = "empty" | "authored" | "invalid";

export interface SnapshotState {
  complete: boolean;
  computedAtSourceRevision: number | null;
  partialAtSourceRevision: number | null;
  missingSceneIds: string[];
  sceneCount: number;
  sceneIds: string[];
  snapshotPaths: Record<string, RelPath>;
  contactSheet: RelPath | null;
}

export interface RenderState {
  jobId: string;
  status: "succeeded" | "partial" | "failed" | "cancelled";
  artifact: RelPath | null;
  computedAtSourceRevision: number | null;
}

export interface ProjectStateFile {
  schemaVersion: 1;
  projectId: ProjectId;
  state: ProjectContentState;
  sceneCount: number;
  lastOpenedAt: string;
  sourceRevision: number;
  snapshots: SnapshotState;
  lastRender: RenderState | null;
  diagnostics: { computedAtSourceRevision: number; errorCount: number; warningCount: number } | null;
  pendingRecovery: string[];
}

export interface ProjectContext {
  slug: string;
  state: ProjectContentState;
  platform: PlatformConfig | null;
  sceneCount: number;
  durationSeconds: number;
  scenes: Array<{ id: string; start: number; duration: number; trackIndex: number }>;
  narration: { cueCount: number; staleSceneIds: string[] };
  openIssues: string[];
}

export interface JobLogLine {
  at: string;
  jobId: string;
  type: string;
  status: JobStatus;
  result: unknown | null;
  errorCode: ErrorCode | null;
}

export interface RevisionLogLine {
  at: string;
  revision: number;
  sourceRevision: number;
  actor: Actor;
  paths: RelPath[];
  summary: string;
}

export interface StructuredLogLine {
  at: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  code?: string;
  detail?: Record<string, unknown>;
}

export interface ReconcileReport {
  rebuilt: boolean;
  stateChanged: boolean;
  jobsChanged: boolean;
  revisionsChanged: boolean;
}

type StateWorkspace = WorkspacePort & Required<Pick<WorkspacePort, "appendAtomic" | "listProjectFiles">>;
type StateJournal = MutationJournalPort & Required<Pick<MutationJournalPort, "listProjectRevisions">>;
type StateJobs = JobStorePort & Required<Pick<JobStorePort, "listProjectJobs">>;

export interface ProjectStateStoreDependencies {
  workspace: StateWorkspace;
  authority: WriteAuthority;
  journal: StateJournal;
  jobs: StateJobs;
  clock: ClockPort;
  actor: Actor;
}

export interface StoredDiagnosticsReport {
  diagnostics: Diagnostic[];
  computedAtSourceRevision: number;
  lintSourceAvailable: boolean;
}

const GITIGNORE = "*\n!.gitignore\n!context/\ncontext/*\n!context/project-context.md\n";
const emptySnapshots = (): SnapshotState => ({
  complete: false,
  computedAtSourceRevision: null,
  partialAtSourceRevision: null,
  missingSceneIds: [],
  sceneCount: 0,
  sceneIds: [],
  snapshotPaths: {},
  contactSheet: null,
});

function hasStoredStale(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasStoredStale);
  return Object.entries(value).some(([key, nested]) => key === "stale" || hasStoredStale(nested));
}

function jobLine(job: Job): JobLogLine {
  return {
    at: job.finishedAt ?? job.startedAt ?? job.createdAt,
    jobId: job.id,
    type: job.type,
    status: job.status,
    result: job.result,
    errorCode: job.error?.code ?? null,
  };
}

function revisionLine(revision: ProjectRevisionProjection): RevisionLogLine {
  return {
    at: revision.createdAt,
    revision: revision.revision,
    sourceRevision: revision.sourceRevision,
    actor: revision.actor,
    paths: revision.paths,
    summary: revision.summary,
  };
}

function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => canonicalizeJson(value)).join("\n") + (values.length ? "\n" : "");
}

function snapshotFrom(job: Job | undefined): SnapshotState {
  const result = job?.result;
  if (!result || typeof result !== "object") return emptySnapshots();
  const value = result as Partial<SnapshotState>;
  return {
    complete: value.complete === true,
    computedAtSourceRevision: typeof value.computedAtSourceRevision === "number"
      ? value.computedAtSourceRevision : null,
    partialAtSourceRevision: typeof value.partialAtSourceRevision === "number"
      ? value.partialAtSourceRevision : null,
    missingSceneIds: Array.isArray(value.missingSceneIds)
      ? value.missingSceneIds.filter((item): item is string => typeof item === "string") : [],
    sceneCount: typeof value.sceneCount === "number" ? value.sceneCount : 0,
    sceneIds: Array.isArray(value.sceneIds)
      ? value.sceneIds.filter((item): item is string => typeof item === "string") : [],
    snapshotPaths: value.snapshotPaths && typeof value.snapshotPaths === "object"
      ? Object.fromEntries(Object.entries(value.snapshotPaths)
          .filter((entry): entry is [string, RelPath] => typeof entry[1] === "string"))
      : {},
    contactSheet: typeof value.contactSheet === "string" ? value.contactSheet as RelPath : null,
  };
}

function renderFrom(job: Job | undefined): RenderState | null {
  if (!job || !["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return null;
  const result = job.result && typeof job.result === "object"
    ? job.result as { artifactPath?: unknown; computedAtSourceRevision?: unknown }
    : null;
  return {
    jobId: job.id,
    status: job.status as RenderState["status"],
    artifact: typeof result?.artifactPath === "string" ? result.artifactPath as RelPath : null,
    computedAtSourceRevision: typeof result?.computedAtSourceRevision === "number"
      ? result.computedAtSourceRevision : null,
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    /api[-_]?key|secret|token|password|authorization|cookie/i.test(key) ? "[REDACTED]" : redact(nested),
  ]));
}

/** Owns the complete `.vidcom` projection while SQLite remains authoritative. */
export class ProjectStateStore {
  constructor(private readonly dependencies: ProjectStateStoreDependencies) {}

  private async sourceRevision(projectId: ProjectId): Promise<number> {
    return await this.dependencies.journal.latestSourceRevision(projectId) ?? 0;
  }

  private async publish(ref: ProjectRef, writes: Array<{ path: DerivedMutationPath; content: string }>) {
    return this.dependencies.authority.mutateDerived({
      ref,
      writes,
      producedByJobId: null,
      computedAtSourceRevision: await this.sourceRevision(ref.id),
    }, this.dependencies.actor);
  }

  async ensure(ref: ProjectRef): Promise<void> {
    const ensureDirectories = this.dependencies.workspace.ensureProjectStateDirectories;
    if (!ensureDirectories) throw new Error("project state directory capability is unavailable");
    await ensureDirectories.call(this.dependencies.workspace, ref);
    const resolved = await this.dependencies.workspace.resolve(ref, ".vidcom/.gitignore", "state-write");
    if (!resolved.ok) throw new Error("project state ignore path is unavailable");
    const current = await this.dependencies.workspace.readFile(resolved.value);
    if (current?.content === GITIGNORE) return;
    const published = await this.publish(ref, [{
      path: ".vidcom/.gitignore" as DerivedMutationPath,
      content: GITIGNORE,
    }]);
    if (!published.ok) throw new Error(published.error.message);
  }

  async readState(ref: ProjectRef): Promise<ProjectStateFile | null> {
    const resolved = await this.dependencies.workspace.resolve(ref, ".vidcom/state.json", "state-write");
    if (!resolved.ok) return null;
    const file = await this.dependencies.workspace.readFile(resolved.value);
    if (!file) return null;
    try { return JSON.parse(file.content) as ProjectStateFile; }
    catch { return null; }
  }

  async writeState(ref: ProjectRef, next: ProjectStateFile): Promise<Result<void, DomainError>> {
    if (hasStoredStale(next)) return err({
      code: "schema_invalid" as DomainError["code"],
      message: "project state must derive staleness instead of storing it",
      field: "stale",
    });
    const published = await this.publish(ref, [{
      path: ".vidcom/state.json" as DerivedMutationPath,
      content: `${canonicalizeJson(next)}\n`,
    }]);
    return published.ok ? ok(undefined) : published;
  }

  async writeContext(ref: ProjectRef, context: ProjectContext): Promise<Result<void, DomainError>> {
    const content = serializeProjectContext(context);
    const published = await this.publish(ref, [{
      path: ".vidcom/context/project-context.md" as DerivedMutationPath,
      content,
    }]);
    return published.ok ? ok(undefined) : published;
  }

  async writeDiagnostics(ref: ProjectRef, report: StoredDiagnosticsReport): Promise<Result<void, DomainError>> {
    const published = await this.publish(ref, [{
      path: ".vidcom/context/diagnostics.json" as DerivedMutationPath,
      content: `${canonicalizeJson(report)}\n`,
    }]);
    return published.ok ? ok(undefined) : published;
  }

  private async append(ref: ProjectRef, path: RelPath, line: unknown): Promise<void> {
    const resolved = await this.dependencies.workspace.resolve(ref, path, "state-write");
    if (!resolved.ok) throw new Error(`project log path is unavailable: ${resolved.error.reason}`);
    await this.dependencies.workspace.appendAtomic(resolved.value, canonicalizeJson(redact(line)));
  }

  appendJobEvent(ref: ProjectRef, line: JobLogLine): Promise<void> {
    return this.append(ref, ".vidcom/jobs/index.jsonl" as RelPath, line);
  }

  appendRevision(ref: ProjectRef, line: RevisionLogLine): Promise<void> {
    return this.append(ref, ".vidcom/revisions/index.jsonl" as RelPath, line);
  }

  log(ref: ProjectRef, line: StructuredLogLine): Promise<void> {
    const day = line.at.slice(0, 10);
    return this.append(ref, `.vidcom/logs/${day}.jsonl` as RelPath, line);
  }

  async pruneLogs(ref: ProjectRef, retentionDays: number): Promise<{ deleted: number }> {
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 365) {
      throw new TypeError("projectLogRetentionDays must be an integer from 0 to 365");
    }
    const cutoff = this.dependencies.clock.now().getTime() - retentionDays * 86_400_000;
    let deleted = 0;
    for (const file of await this.dependencies.workspace.listProjectFiles(ref, ".vidcom/logs" as RelPath)) {
      if (retentionDays !== 0 && file.modifiedAtMs >= cutoff) continue;
      const resolved = await this.dependencies.workspace.resolve(ref, file.path, "state-write");
      if (!resolved.ok) continue;
      await this.dependencies.workspace.deleteAtomic(resolved.value);
      deleted += 1;
    }
    return { deleted };
  }

  async reconcile(ref: ProjectRef): Promise<ReconcileReport> {
    const [jobs, revisions, sourceRevision] = await Promise.all([
      this.dependencies.jobs.listProjectJobs(ref.id),
      this.dependencies.journal.listProjectRevisions(ref.id),
      this.sourceRevision(ref.id),
    ]);
    const latestSnapshot = [...jobs].reverse().find((job) => job.type === "snapshot"
      && ["succeeded", "partial"].includes(job.status));
    const latestRender = [...jobs].reverse().find((job) => job.type === "render"
      && ["succeeded", "partial", "failed", "cancelled"].includes(job.status));
    const entry = await this.dependencies.workspace.resolve(ref, ref.entry, "read-source");
    const hasComposition = entry.ok && await this.dependencies.workspace.exists(entry.value);
    const snapshots = snapshotFrom(latestSnapshot);
    const state: ProjectStateFile = {
      schemaVersion: 1,
      projectId: ref.id,
      state: hasComposition ? "authored" : "empty",
      sceneCount: snapshots.sceneCount,
      lastOpenedAt: this.dependencies.clock.now().toISOString(),
      sourceRevision,
      snapshots,
      lastRender: renderFrom(latestRender),
      diagnostics: null,
      pendingRecovery: [],
    };
    const writes = [
      { path: ".vidcom/state.json" as DerivedMutationPath, content: `${canonicalizeJson(state)}\n` },
      { path: ".vidcom/jobs/index.jsonl" as DerivedMutationPath, content: jsonLines(jobs.map(jobLine)) },
      {
        path: ".vidcom/revisions/index.jsonl" as DerivedMutationPath,
        content: jsonLines(revisions.map(revisionLine)),
      },
    ];
    const published = await this.publish(ref, writes);
    if (!published.ok) throw new Error(published.error.message);
    return { rebuilt: true, stateChanged: true, jobsChanged: true, revisionsChanged: true };
  }
}

export function serializeProjectContext(context: ProjectContext): string {
  const platform = context.platform;
  const lines = [
    `# ${context.slug}`,
    "",
    `- State: ${context.state}`,
    `- Platform: ${platform ? `${platform.presetId} (${platform.orientation}, ${platform.width}x${platform.height} @ ${platform.fps}fps)` : "unassigned"}`,
    `- Duration: ${context.durationSeconds}s`,
    `- Scenes: ${context.sceneCount}`,
    `- Narration cues: ${context.narration.cueCount}`,
    `- Stale narration scenes: ${[...context.narration.staleSceneIds].sort().join(", ") || "none"}`,
    "",
    "## Scene timeline",
    "",
    ...[...context.scenes]
      .sort((left, right) => left.trackIndex - right.trackIndex || left.start - right.start || left.id.localeCompare(right.id))
      .map((scene) => `- ${scene.id}: track ${scene.trackIndex}, ${scene.start}s + ${scene.duration}s`),
    "",
    "## Open issues",
    "",
    ...([...context.openIssues].sort().map((issue) => `- ${issue}`).length
      ? [...context.openIssues].sort().map((issue) => `- ${issue}`)
      : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

/** Derived view only; this value is intentionally never persisted. */
export function isStale(computedAtSourceRevision: number | null, sourceRevision: number): boolean {
  return computedAtSourceRevision !== null && computedAtSourceRevision < sourceRevision;
}
