import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  commitStaging,
  copyIntoStaging,
  sourceIdentityOf,
  stagingPathFor,
  writeStagingMarker,
} from "@vidcom/adapter";
import { ErrorCode, type DomainError } from "@vidcom/contracts";
import {
  assertSourceUnchanged,
  importIdempotencyKey,
  planProjectImport,
  type AbsolutePath,
  type Result,
  type WorkspaceOperationId,
  type WorkspaceOperationJournalPort,
} from "@vidcom/core";
import type { ProjectImportJobDependencies } from "@vidcom/worker";

export interface ImportSelection {
  canonicalPath: string;
  identity: { device: string; inode: string };
}

export interface ProjectImportServiceDependencies {
  workspaceRoot: string;
  /** Slugs already taken, so the plan picks a free one rather than colliding. */
  takenSlugs(): Promise<readonly string[]>;
  /** Resolves a browse selection token; null when the token is not this session's. */
  resolveSelection(token: string): ImportSelection | null;
  findExisting(idempotencyKey: string): Promise<{
    id: string;
    status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  } | null>;
  enqueue(input: {
    source: string;
    sourceIdentity: string;
    workspaceRoot: string;
    idempotencyKey: string;
    targetName?: string;
  }): Promise<Result<{ id: string }, DomainError>>;
}

function invalidToken(): DomainError {
  return {
    code: ErrorCode.BrowseTokenInvalid,
    message: "import selection token is not valid",
  };
}

/**
 * Turns a browse selection into a queued import.
 *
 * The token is the only accepted way in. A path a client can type is a path any
 * page can send, and the whole point of browse is that the server acts only on
 * directories it handed out itself — so this resolves the token and never reads
 * an absolute path from the request.
 *
 * Nothing is copied here. The endpoint answers 202 with a job id because
 * copying a project tree is not something to hold a request open for.
 */
export function createStartProjectImport(dependencies: ProjectImportServiceDependencies) {
  let tail = Promise.resolve();
  return async (input: { selectionToken: string; targetName?: string }):
  Promise<Result<{ jobId: string }, DomainError>> => {
    const selection = dependencies.resolveSelection(input.selectionToken);
    if (!selection) return { ok: false, error: invalidToken() };
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const sourceIdentity = await sourceIdentityOf(selection.canonicalPath);
      const [device, inode] = sourceIdentity.split(":", 2);
      if (selection.identity.device !== device || selection.identity.inode !== inode) {
        return { ok: false, error: invalidToken() };
      }
      // NUL separates fields because it is the one byte a native path cannot
      // contain; ordinary punctuation can make two different tuples collide.
      const idempotencyKey = importIdempotencyKey({
        workspaceRoot: dependencies.workspaceRoot,
        sourceCanonicalIdentity: sourceIdentity,
        ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
      }, (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`);
      const existing = await dependencies.findExisting(idempotencyKey);
      if (existing?.status === "queued" || existing?.status === "running") {
        return { ok: true, value: { jobId: existing.id } };
      }
      if (existing?.status === "succeeded" || existing?.status === "partial") {
        return { ok: false, error: {
          code: ErrorCode.ProjectImportConflict,
          message: "this project source was already imported into the selected target",
        } };
      }

      // Planned before queuing, so a source that overlaps the workspace or a name
      // that cannot become a slug is refused while the caller is still listening
      // rather than inside a job they have to go and read.
      const planned = planProjectImport({
        source: selection.canonicalPath as AbsolutePath,
        workspaceRoot: dependencies.workspaceRoot as AbsolutePath,
        taken: await dependencies.takenSlugs(),
        ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
        sourceIdentity,
      });
      if (!planned.ok) return planned;

      const enqueued = await dependencies.enqueue({
        source: selection.canonicalPath,
        sourceIdentity,
        workspaceRoot: dependencies.workspaceRoot,
        idempotencyKey,
        ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
      });
      if (!enqueued.ok) return enqueued;
      return { ok: true, value: { jobId: enqueued.value.id } };
    } finally {
      release();
    }
  };
}

/**
 * The filesystem half of the import job, bound to real directories.
 *
 * Each operation is the one the staging suites already cover; this exists to
 * hand the job a set that talks to a real workspace rather than to a fixture.
 */
export function createProjectImportJobDependencies(input: {
  takenSlugs(): Promise<readonly string[]>;
  backfill(target: string): Promise<void>;
  journal: WorkspaceOperationJournalPort;
  leaseId: string;
  now(): string;
}): ProjectImportJobDependencies {
  return {
    async plan({ source, sourceIdentity, workspaceRoot, targetName }) {
      const planned = planProjectImport({
        source: source as AbsolutePath,
        workspaceRoot: workspaceRoot as AbsolutePath,
        taken: await input.takenSlugs(),
        ...(targetName === undefined ? {} : { targetName }),
        sourceIdentity,
      });
      if (!planned.ok) throw new Error(planned.error.message);
      const unchanged = assertSourceUnchanged(planned.value, await sourceIdentityOf(source));
      if (!unchanged.ok) throw new Error(unchanged.error.message);

      const operationId = await input.journal.begin({
        workspaceRoot: workspaceRoot as AbsolutePath,
        kind: "project_import",
        projectId: null,
        fromPath: source,
        toPath: planned.value.slug,
        stagingPath: null,
        actor: "user",
        action: "project.import",
      }, [], { leaseId: input.leaseId });
      // The journal id names the staging directory, so recovery can bind the
      // filesystem marker to exactly one durable operation.
      const markerId = String(operationId);
      const staging = stagingPathFor(planned.value, markerId);
      try {
        await input.journal.setDirectoryPaths(operationId, { stagingPath: staging });
        await writeStagingMarker(staging, {
          operationId: markerId,
          slug: planned.value.slug,
          source,
          target: planned.value.target,
          startedAt: input.now(),
        });
      } catch (error) {
        await input.journal.abort(operationId, ErrorCode.StorageUnavailable).catch(() => undefined);
        throw error;
      }
      return { operationId: markerId, slug: planned.value.slug, target: planned.value.target, staging };
    },

    async copy(source, staging) {
      const report = await copyIntoStaging(source, staging);
      if ("code" in report) throw new Error(report.message);
      return { files: report.files };
    },

    async commit(staging, target) {
      const failure = await commitStaging(staging, target);
      if (failure) throw new Error(failure.message);
    },

    async discard(staging) {
      await rm(staging, { recursive: true, force: true });
    },

    backfill: input.backfill,

    async settle(operationId, outcome) {
      const id = Number(operationId) as WorkspaceOperationId;
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError("project import operation id is invalid");
      if (outcome === "commit") await input.journal.commit(id);
      else if (outcome === "abort") await input.journal.abort(id, ErrorCode.StorageUnavailable);
      else await input.journal.orphan(id, ErrorCode.RecoveryRequired);
    },
  };
}
