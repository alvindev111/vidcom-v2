import { ErrorCode, type Actor, type ContentHash, type DomainError, type RelPath } from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { CompositionPort, CompositeMutationJournalPort, LeasePort, WorkspacePort } from "../port/ports";
import type { JournalId, PathPurpose, ResolvedPath, StepIntent, StepResult, WriteEnvelope } from "../port/types";

export type OrphanResolution = "restore-previous" | "accept-current";

export interface ResolveOrphanedMutationDependencies {
  workspace: WorkspacePort;
  journal: CompositeMutationJournalPort;
  composition: CompositionPort;
  lease: LeasePort;
  leaseId: string;
  resolveProjectRef(projectId: Parameters<CompositeMutationJournalPort["readProjectRecoveryStatus"]>[0]): Promise<ProjectRef | null>;
}

interface ResolvedOrphanStep {
  step: StepIntent;
  target: ResolvedPath;
}

class RecoveryProjectMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<Value>(projectId: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(projectId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    }
  }
}

const recoveryMutex = new RecoveryProjectMutex();

function purposeForStep(step: StepIntent): PathPurpose {
  if (step.kind === "entity" || step.path === "preview-settings.json"
    || (step.path?.startsWith("narration/") && step.path.endsWith(".json"))) return "system-write";
  if (step.path && ["assets/", "preview-assets/", "narration/", "snapshots/", "renders/"]
    .some((root) => step.path?.startsWith(root))) return "write-asset";
  return "write-source";
}

async function resolveSteps(
  dependencies: ResolveOrphanedMutationDependencies,
  ref: ProjectRef,
  steps: readonly StepIntent[],
): Promise<ResolvedOrphanStep[] | null> {
  const resolvedSteps: ResolvedOrphanStep[] = [];
  for (const step of steps) {
    const path: RelPath | null = step.kind === "entity"
      ? (await dependencies.journal.readEntityState(ref.id, step.entity))?.backingPath ?? null
      : step.path;
    if (!path) return null;
    const target = await dependencies.workspace.resolve(ref, path, purposeForStep(step));
    if (!target.ok) return null;
    resolvedSteps.push({ step, target: target.value });
  }
  return resolvedSteps;
}

async function restorePrevious(
  dependencies: ResolveOrphanedMutationDependencies,
  steps: readonly ResolvedOrphanStep[],
): Promise<boolean> {
  const descending = [...steps].sort((left, right) => right.step.ordinal - left.step.ordinal);
  for (const { step, target } of descending) {
    try {
      if (step.fromHash === null) await dependencies.workspace.deleteAtomic(target);
      else {
        if (step.previousContent === null) return false;
        await dependencies.workspace.writeAtomic(target, step.previousContent);
      }
      if (await dependencies.workspace.readHash(target) !== step.fromHash) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function acceptedStep(step: StepIntent, actualHash: ContentHash | null): StepResult | null {
  if (actualHash === null) {
    if (step.kind === "entity") return null;
    return { ...step, kind: "delete", toHash: null, status: "written" };
  }
  if (step.kind === "entity") return { ...step, toHash: actualHash, status: "written" };
  return { ...step, kind: "write", toHash: actualHash, status: "written" };
}

async function acceptCurrent(
  dependencies: ResolveOrphanedMutationDependencies,
  journalId: JournalId,
  ref: ProjectRef,
  actor: Actor,
  steps: readonly ResolvedOrphanStep[],
): Promise<Result<WriteEnvelope, DomainError>> {
  try {
    const model = await dependencies.composition.parseProject(ref);
    if (model.diagnostics.some(({ severity }) => severity === "error")) {
      return err({ code: ErrorCode.SdkRejected, message: "the current project state has validation errors" });
    }
    for (const source of model.sources) {
      const target = await dependencies.workspace.resolve(ref, source.path, "read-source");
      if (!target.ok) return err({ code: ErrorCode.SdkRejected, message: "a current composition source is unavailable" });
      const file = await dependencies.workspace.readFile(target.value);
      if (!file) return err({ code: ErrorCode.SdkRejected, message: "a current composition source is missing" });
      const validation = await dependencies.composition.validateSource?.(source.path, file.content);
      if (validation && !validation.ok) return validation;
    }
    const accepted: StepResult[] = [];
    for (const { step, target } of steps) {
      const current = acceptedStep(step, await dependencies.workspace.readHash(target));
      if (!current) return err({ code: ErrorCode.SdkRejected, message: "the current entity state is missing" });
      accepted.push(current);
    }
    const envelope = await dependencies.journal.resolveOrphanedAccept(journalId, {
      projectId: ref.id,
      actor,
      steps: accepted,
      diagnostics: model.diagnostics,
      recovered: true,
      event: { type: "project.changed", projectId: ref.id, payload: { recovery: "accept-current" } },
    });
    return ok(envelope);
  } catch {
    return err({ code: ErrorCode.RecoveryRequired, message: "the current project state could not be accepted" });
  }
}

/** Resolves exactly one orphaned journal after an explicit CLI choice, without opening the general write gate. */
export async function resolveOrphanedMutation(
  dependencies: ResolveOrphanedMutationDependencies,
  journalId: JournalId,
  resolution: OrphanResolution,
  actor: "cli-external",
): Promise<Result<WriteEnvelope | null, DomainError>> {
  if (!(await dependencies.lease.assertHeld(dependencies.leaseId))) {
    return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
  }
  const mutation = await dependencies.journal.readPendingComposite(journalId);
  if (!mutation || mutation.status !== "orphaned") {
    return err({ code: ErrorCode.RecoveryRequired, message: "the requested orphaned mutation was not found" });
  }
  return recoveryMutex.run(mutation.projectId, async () => {
    if (!(await dependencies.lease.assertHeld(dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    const current = await dependencies.journal.readPendingComposite(journalId);
    if (!current || current.status !== "orphaned" || current.projectId !== mutation.projectId) {
      return err({ code: ErrorCode.RecoveryRequired, message: "the orphan changed before resolution" });
    }
    const ref = await dependencies.resolveProjectRef(current.projectId);
    if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "the orphaned project was not found" });
    const steps = await resolveSteps(dependencies, ref, current.steps);
    if (!steps) return err({ code: ErrorCode.RecoveryRequired, message: "the orphan targets could not be resolved" });
    if (resolution === "accept-current") return acceptCurrent(dependencies, journalId, ref, actor, steps);
    if (!(await restorePrevious(dependencies, steps))) {
      return err({ code: ErrorCode.RecoveryRequired, message: "the previous state could not be restored and verified" });
    }
    try {
      await dependencies.journal.resolveOrphanedRestore(journalId, actor);
      return ok(null);
    } catch {
      return err({ code: ErrorCode.RecoveryRequired, message: "the restored orphan could not be finalized" });
    }
  });
}
