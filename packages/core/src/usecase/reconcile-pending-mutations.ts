import { ErrorCode, type RelPath } from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import type { MutationJournalPort, WorkspacePort } from "../port/ports";
import type { JournalId, MutationResult, PathPurpose, PendingMutation } from "../port/types";

export interface ReconciliationDependencies {
  workspace: WorkspacePort;
  journal: MutationJournalPort;
  resolveProjectRef(projectId: PendingMutation["projectId"]): Promise<ProjectRef | null>;
}

export interface ReconciliationReport {
  aborted: JournalId[];
  recovered: JournalId[];
  orphaned: JournalId[];
}

function purposeFor(path: RelPath, mutation: PendingMutation): PathPurpose {
  return mutation.kind === "entity" || path === "vidcom.json" || path === "preview-settings.json"
    ? "system-write"
    : "write-source";
}

function recoveredResult(mutation: PendingMutation): MutationResult {
  const identity = mutation.path === "vidcom.json";
  return {
    ...mutation,
    event: mutation.kind === "file" && !identity
      ? {
          type: "file.changed",
          projectId: mutation.projectId,
          payload: { path: mutation.path },
        }
      : {
          type: "project.changed",
          projectId: mutation.projectId,
          payload: identity ? { identity: "assigned" } : { entity: mutation.entity },
        },
  };
}

/** Reconciles every durable pre-write intent before the daemon accepts requests. */
export async function reconcilePendingMutations(
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationReport> {
  const report: ReconciliationReport = { aborted: [], recovered: [], orphaned: [] };
  for (const mutation of await dependencies.journal.listPending()) {
    const ref = await dependencies.resolveProjectRef(mutation.projectId);
    const path = mutation.kind === "entity"
      ? (await dependencies.journal.readEntityState(mutation.projectId, mutation.entity!))?.backingPath ?? null
      : mutation.path;
    if (!ref || !path) {
      await dependencies.journal.orphan(mutation.id, null);
      report.orphaned.push(mutation.id);
      continue;
    }

    const resolved = await dependencies.workspace.resolve(ref, path, purposeFor(path, mutation));
    if (!resolved.ok) {
      await dependencies.journal.orphan(mutation.id, null);
      report.orphaned.push(mutation.id);
      continue;
    }

    const actualHash = await dependencies.workspace.readHash(resolved.value);
    if (actualHash === mutation.fromHash) {
      await dependencies.journal.abort(mutation.id, ErrorCode.StorageUnavailable);
      report.aborted.push(mutation.id);
    } else if (actualHash === mutation.toHash) {
      await dependencies.journal.recover(mutation.id, recoveredResult(mutation));
      report.recovered.push(mutation.id);
    } else {
      await dependencies.journal.orphan(mutation.id, actualHash);
      report.orphaned.push(mutation.id);
    }
  }
  return report;
}
