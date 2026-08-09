import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  commitStaging,
  copyIntoStaging,
  sourceIdentityOf,
  stagingPathFor,
  writeStagingMarker,
} from "@vidcom/adapter";
import { ErrorCode, type DomainError } from "@vidcom/contracts";
import { planProjectImport, type AbsolutePath, type Result } from "@vidcom/core";
import type { ProjectImportJobDependencies } from "@vidcom/worker";

export interface ImportSelection {
  canonicalPath: string;
}

export interface ProjectImportServiceDependencies {
  workspaceRoot: string;
  /** Slugs already taken, so the plan picks a free one rather than colliding. */
  takenSlugs(): Promise<readonly string[]>;
  /** Resolves a browse selection token; null when the token is not this session's. */
  resolveSelection(token: string): ImportSelection | null;
  enqueue(input: { source: string; workspaceRoot: string; targetName?: string }):
    Promise<Result<{ id: string }, DomainError>>;
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
  return async (input: { selectionToken: string; targetName?: string }):
  Promise<Result<{ jobId: string }, DomainError>> => {
    const selection = dependencies.resolveSelection(input.selectionToken);
    if (!selection) return { ok: false, error: invalidToken() };

    // Planned before queuing, so a source that overlaps the workspace or a name
    // that cannot become a slug is refused while the caller is still listening
    // rather than inside a job they have to go and read.
    const planned = planProjectImport({
      source: selection.canonicalPath as AbsolutePath,
      workspaceRoot: dependencies.workspaceRoot as AbsolutePath,
      taken: await dependencies.takenSlugs(),
      ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
      sourceIdentity: await sourceIdentityOf(selection.canonicalPath),
    });
    if (!planned.ok) return planned;

    const enqueued = await dependencies.enqueue({
      source: selection.canonicalPath,
      workspaceRoot: dependencies.workspaceRoot,
      ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
    });
    if (!enqueued.ok) return enqueued;
    return { ok: true, value: { jobId: enqueued.value.id } };
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
}): ProjectImportJobDependencies {
  return {
    async plan({ source, workspaceRoot, targetName }) {
      const planned = planProjectImport({
        source: source as AbsolutePath,
        workspaceRoot: workspaceRoot as AbsolutePath,
        taken: await input.takenSlugs(),
        ...(targetName === undefined ? {} : { targetName }),
        sourceIdentity: await sourceIdentityOf(source),
      });
      if (!planned.ok) throw new Error(planned.error.message);

      // The operation id names the staging directory, so two imports of the
      // same source never share one — which is what makes recovery able to say
      // whose leftovers it found.
      const operationId = randomUUID();
      const staging = stagingPathFor(planned.value, operationId);
      await writeStagingMarker(staging, {
        operationId,
        slug: planned.value.slug,
        source,
        target: planned.value.target,
        startedAt: new Date().toISOString(),
      });
      return { slug: planned.value.slug, target: planned.value.target, staging };
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
  };
}
