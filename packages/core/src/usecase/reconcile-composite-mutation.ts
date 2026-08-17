import { ErrorCode, type DomainEvent, type PreviewSettingsDto, type RelPath } from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import { DEFAULT_PREVIEW_SETTINGS, normalizePreviewSettings } from "../domain/preview-settings";
import { err, ok, type Result } from "../error/result";
import type { MutationObserverPort, MutationReceipt, MutationReceiptStep } from "../port/mutation-observer";
import type { ClockPort, CompositeMutationJournalPort, WorkspacePort } from "../port/ports";
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
  observer?: MutationObserverPort;
  clock?: ClockPort;
}

export interface CompositeReconciliationReport {
  pending: JournalId[];
  recovered: JournalId[];
  rolledBack: JournalId[];
  orphaned: JournalId[];
}

function purposeForStep(step: StepIntent): PathPurpose {
  if (step.kind === "mkdir" || step.kind === "rmdir") return "authored-write";
  if (step.kind === "entity" || step.path === "preview-settings.json"
    || (step.path?.startsWith("narration/") && step.path.endsWith(".json"))) return "system-write";
  if (step.path && ["assets/", "preview-assets/", "narration/", "snapshots/", "renders/"]
    .some((root) => step.path?.startsWith(root))) return "write-asset";
  return "write-source";
}

function recoveryEvent(mutation: PendingCompositeMutation, paths: readonly RelPath[]): DomainEvent {
  const single = mutation.steps.length === 1 ? mutation.steps[0] : null;
  if (single?.kind === "entity") {
    return { type: "project.changed", projectId: mutation.projectId, payload: { entity: single.entity, paths, source: "system" } };
  }
  if (single) return {
    type: "file.changed",
    projectId: mutation.projectId,
    payload: { path: single.path, paths, source: "system" },
  };
  return { type: "project.changed", projectId: mutation.projectId, payload: { composite: true, paths, source: "system" } };
}

async function recoveryPaths(
  dependencies: CompositeReconciliationDependencies,
  mutation: PendingCompositeMutation,
): Promise<RelPath[] | null> {
  const paths: RelPath[] = [];
  for (const step of mutation.steps) {
    if (step.kind !== "entity") {
      paths.push(step.path);
      continue;
    }
    const state = await dependencies.journal.readEntityState(mutation.projectId, step.entity);
    if (!state) return null;
    paths.push(state.backingPath);
  }
  return paths;
}

function previewState(content: string | Uint8Array | null): PreviewSettingsDto | null {
  if (content === null) return null;
  try {
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    return normalizePreviewSettings(JSON.parse(text));
  } catch {
    return null;
  }
}

async function emitRecoveryReceipt(
  dependencies: CompositeReconciliationDependencies,
  mutation: PendingCompositeMutation,
  observations: readonly ObservedCompositeStep[],
  envelope: Extract<CompositeReconcileOutcome, { terminal: "committed" }>["envelope"],
): Promise<void> {
  if (!dependencies.observer || !dependencies.clock) return;
  const receiptSteps: MutationReceiptStep[] = [];
  const paths: RelPath[] = [];
  for (const observation of observations) {
    const step = observation.step;
    if (step.kind === "mkdir" || step.kind === "rmdir") {
      paths.push(step.path);
      receiptSteps.push({
        kind: "directory",
        undoable: false,
        op: step.kind,
        path: step.path,
        existedBefore: step.existedBefore,
      });
      continue;
    }
    if (step.kind !== "entity") {
      paths.push(step.path);
      receiptSteps.push({
        kind: "file",
        undoable: false,
        path: step.path,
        fromHash: step.fromHash,
        toHash: step.toHash,
        omittedReason: "not-undoable",
      });
      continue;
    }
    const state = await dependencies.journal.readEntityState(mutation.projectId, step.entity);
    const current = await dependencies.workspace.readFile(observation.target);
    const backingPath = state?.backingPath ?? "preview-settings.json" as RelPath;
    paths.push(backingPath);
    receiptSteps.push({
      kind: "entity",
      undoable: false,
      entity: step.entity,
      backingPath,
      beforeState: previewState(step.previousContent),
      afterState: previewState(current?.content ?? null) ?? DEFAULT_PREVIEW_SETTINGS,
      fromRevision: Math.max(0, (state?.revision ?? 1) - 1),
      toRevision: state?.revision ?? 1,
      fromHash: step.fromHash,
      toHash: step.toHash,
    });
  }
  const receipt: MutationReceipt = {
    id: `journal:${mutation.id}`,
    projectId: mutation.projectId,
    origin: {
      kind: "system",
      sessionId: null,
      label: null,
      historyAction: "ignore",
      historyOperation: null,
    },
    steps: receiptSteps,
    paths,
    readGuards: [],
    projectRevision: envelope.projectRevision,
    at: dependencies.clock.now().toISOString(),
    undoable: false,
  };
  try {
    const emitted = dependencies.observer.emit(receipt);
    if (!emitted.ok) dependencies.observer.invalidateProject(mutation.projectId, "history-desync");
  } catch {
    dependencies.observer.invalidateProject(mutation.projectId, "history-desync");
  }
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
    if (step.kind === "mkdir" || step.kind === "rmdir") {
      const state = await dependencies.workspace.stat(resolved.value);
      const actualDirectoryState = state === null
        ? "absent" as const
        : state.kind === "directory" ? "directory" as const : "other" as const;
      observations.push({
        step,
        target: resolved.value,
        actualHash: null,
        actualDirectoryState,
        classification: classifyCompositeStep(step, null, actualDirectoryState),
      });
      continue;
    }
    const actualHash = await dependencies.workspace.readHash(resolved.value);
    observations.push({ step, target: resolved.value, actualHash, classification: classifyCompositeStep(step, actualHash) });
  }
  return observations;
}

async function captureSettlementBoundary(
  workspace: WorkspacePort,
  observations: readonly ObservedCompositeStep[],
  journalId: JournalId,
): Promise<boolean> {
  for (const observation of observations) {
    const captured = await workspace.captureForMutation(
      observation.target,
      observation.step.kind === "mkdir" || observation.step.kind === "rmdir"
        ? { kind: "directory", existedBefore: observation.actualDirectoryState === "directory" }
        : observation.actualHash,
      journalId,
      observation.step.ordinal + 2_000_000,
    );
    if (!captured.ok) return false;
    const settlementState = observation.step.kind === "mkdir" || observation.step.kind === "rmdir"
      ? { kind: "directory" as const, exists: observation.actualDirectoryState === "directory" }
      : null;
    if (!(await workspace.restoreCaptured(captured.value, settlementState))) {
      await workspace.discardCapture(captured.value).catch(() => {});
      return false;
    }
    await workspace.discardCapture(captured.value);
  }
  return true;
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
  try {
    if (!(await captureSettlementBoundary(dependencies.workspace, observations, mutation.id))) {
      return err({
        code: ErrorCode.RecoveryRequired,
        message: "the mutation targets changed during recovery settlement",
      });
    }
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "the mutation targets could not be revalidated" });
  }
  if (decision === "roll_forward") {
    try {
      const paths = await recoveryPaths(dependencies, mutation);
      if (!paths) return orphan(dependencies, mutation, "orphaned");
      const envelope = await dependencies.journal.commitComposite(
        mutation.id,
        {
          projectId: mutation.projectId,
          actor: mutation.actor,
          steps: mutation.steps.map((step) => ({ ...step, status: "written" })),
          event: recoveryEvent(mutation, paths),
          diagnostics: [],
          recovered: true,
        },
        mutation.grantId ? { kind: "consume", grantId: mutation.grantId } : undefined,
      );
      await emitRecoveryReceipt(dependencies, mutation, observations, envelope);
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

  if (!(await rollbackObservedCompositeSteps(dependencies.workspace, observations, mutation.id))) {
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
  dependencies: CompositeReconciliationDependencies & { workspaceRoot: string },
): Promise<CompositeReconciliationReport> {
  const report: CompositeReconciliationReport = {
    pending: [],
    recovered: [],
    rolledBack: [],
    orphaned: [],
  };
  for (const mutation of await dependencies.journal.listPendingComposites(dependencies.workspaceRoot)) {
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
