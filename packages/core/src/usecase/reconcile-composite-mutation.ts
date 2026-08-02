import { ErrorCode, type DomainEvent, type RelPath } from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { CompositeMutationJournalPort, WorkspacePort } from "../port/ports";
import type {
  CompositeReconcileOutcome,
  JournalId,
  PathPurpose,
  PendingCompositeMutation,
  PendingToolAudit,
  StepIntent,
} from "../port/types";
import {
  classifyCompositeStep,
  decideCompositeRecovery,
  rollbackObservedCompositeSteps,
  type ObservedCompositeStep,
} from "../service/composite-recovery";

export interface CompositeReconciliationDependencies {
  workspace: WorkspacePort;
  journal: CompositeMutationJournalPort;
  resolveProjectRef(projectId: PendingCompositeMutation["projectId"]): Promise<ProjectRef | null>;
  recordFailure?(audit: PendingToolAudit, reason: ErrorCode): Promise<void>;
}

export interface CompositeReconciliationReport {
  pending: JournalId[];
  recovered: JournalId[];
  rolledBack: JournalId[];
  orphaned: JournalId[];
}

function purposeForStep(step: StepIntent): PathPurpose {
  if (step.kind === "entity" || step.path === "preview-settings.json"
    || (step.path?.startsWith("narration/") && step.path.endsWith(".json"))) return "system-write";
  if (step.path && ["assets/", "preview-assets/", "narration/", "snapshots/", "renders/"]
    .some((root) => step.path?.startsWith(root))) return "write-asset";
  return "write-source";
}

function recoveryEvent(mutation: PendingCompositeMutation): DomainEvent {
  const single = mutation.steps.length === 1 ? mutation.steps[0] : null;
  if (single?.kind === "entity") {
    return { type: "project.changed", projectId: mutation.projectId, payload: { entity: single.entity } };
  }
  if (single) return { type: "file.changed", projectId: mutation.projectId, payload: { path: single.path } };
  return { type: "project.changed", projectId: mutation.projectId, payload: { composite: true } };
}

async function recordFailureBestEffort(
  dependencies: CompositeReconciliationDependencies,
  audit: PendingToolAudit | null,
  reason: ErrorCode,
): Promise<void> {
  if (!audit || !dependencies.recordFailure) return;
  await dependencies.recordFailure(audit, reason).catch(() => {});
}

async function orphan(
  dependencies: CompositeReconciliationDependencies,
  mutation: PendingCompositeMutation,
  reason: "orphaned" | "rollback_failed",
): Promise<Result<CompositeReconcileOutcome, { code: ErrorCode; message: string }>> {
  try {
    await dependencies.journal.orphanComposite(
      mutation.id,
      ErrorCode.RecoveryRequired,
      mutation.grantId
        ? { kind: "invalidate", grantId: mutation.grantId, reason }
        : undefined,
    );
    return ok({ terminal: "orphaned" });
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "the orphan recovery transition could not be persisted" });
  }
}

async function observeSteps(
  dependencies: CompositeReconciliationDependencies,
  mutation: PendingCompositeMutation,
  ref: ProjectRef,
): Promise<ObservedCompositeStep[] | null> {
  const observations: ObservedCompositeStep[] = [];
  for (const step of mutation.steps) {
    const path: RelPath | null = step.kind === "entity"
      ? (await dependencies.journal.readEntityState(mutation.projectId, step.entity))?.backingPath ?? null
      : step.path;
    if (!path) return null;
    const resolved = await dependencies.workspace.resolve(ref, path, purposeForStep(step));
    if (!resolved.ok) return null;
    const actualHash = await dependencies.workspace.readHash(resolved.value);
    observations.push({ step, target: resolved.value, classification: classifyCompositeStep(step, actualHash) });
  }
  return observations;
}

/** Reconciles one pending composite strictly from durable context and current filesystem hashes. */
export async function reconcileCompositeMutation(
  dependencies: CompositeReconciliationDependencies,
  journalId: JournalId,
): Promise<Result<CompositeReconcileOutcome, { code: ErrorCode; message: string }>> {
  const mutation = await dependencies.journal.readPendingComposite(journalId);
  if (!mutation) return err({ code: ErrorCode.RecoveryRequired, message: "the unresolved mutation was not found" });
  if (mutation.status === "orphaned") return ok({ terminal: "orphaned" });
  const ref = await dependencies.resolveProjectRef(mutation.projectId);
  if (!ref) return orphan(dependencies, mutation, "orphaned");
  let observations: ObservedCompositeStep[] | null;
  try {
    observations = await observeSteps(dependencies, mutation, ref);
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "the mutation targets could not be inspected" });
  }
  if (!observations) return orphan(dependencies, mutation, "orphaned");

  const decision = decideCompositeRecovery(observations.map(({ classification }) => classification));
  if (decision === "orphan") return orphan(dependencies, mutation, "orphaned");
  if (decision === "roll_forward") {
    try {
      const envelope = await dependencies.journal.commitComposite(
        mutation.id,
        {
          projectId: mutation.projectId,
          actor: mutation.actor,
          steps: mutation.steps.map((step) => ({ ...step, status: "written" })),
          event: recoveryEvent(mutation),
          diagnostics: [],
          recovered: true,
        },
        mutation.grantId ? { kind: "consume", grantId: mutation.grantId } : undefined,
      );
      return ok({ terminal: "committed", envelope });
    } catch {
      return err({ code: ErrorCode.StorageUnavailable, message: "the recovered mutation could not be committed" });
    }
  }

  const reason = ErrorCode.StorageUnavailable;
  if (decision === "abort") {
    try {
      const context = await dependencies.journal.abortComposite(
        mutation.id,
        reason,
        mutation.grantId ? { kind: "release", grantId: mutation.grantId } : undefined,
      );
      await recordFailureBestEffort(dependencies, context?.toolAudit ?? null, reason);
      return ok({ terminal: "aborted" });
    } catch {
      return err({ code: ErrorCode.StorageUnavailable, message: "the unchanged mutation could not be aborted" });
    }
  }

  if (!(await rollbackObservedCompositeSteps(dependencies.workspace, observations))) {
    return orphan(dependencies, mutation, "rollback_failed");
  }
  try {
    const context = await dependencies.journal.rollbackComposite(
      mutation.id,
      reason,
      mutation.grantId ? { kind: "release", grantId: mutation.grantId } : undefined,
    );
    await recordFailureBestEffort(dependencies, context?.toolAudit ?? null, reason);
    return ok({ terminal: "rolled_back" });
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "the restored mutation could not be settled" });
  }
}

/** Reconciles unresolved journals independently so one quarantined project cannot block healthy projects. */
export async function reconcileCompositeMutations(
  dependencies: CompositeReconciliationDependencies,
): Promise<CompositeReconciliationReport> {
  const report: CompositeReconciliationReport = {
    pending: [],
    recovered: [],
    rolledBack: [],
    orphaned: [],
  };
  for (const mutation of await dependencies.journal.listPendingComposites()) {
    let result: Awaited<ReturnType<typeof reconcileCompositeMutation>>;
    try {
      result = await reconcileCompositeMutation(dependencies, mutation.id);
    } catch {
      report.pending.push(mutation.id);
      continue;
    }
    if (!result.ok) report.pending.push(mutation.id);
    else if (result.value.terminal === "committed") report.recovered.push(mutation.id);
    else if (result.value.terminal === "orphaned") report.orphaned.push(mutation.id);
    else report.rolledBack.push(mutation.id);
  }
  return report;
}
