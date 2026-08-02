import type { ContentHash } from "@vidcom/contracts";

import type { WorkspacePort } from "../port/ports";
import type { JournalId, ResolvedPath, StepIntent } from "../port/types";

/** Filesystem truth for one durable step; persisted step status is intentionally excluded. */
export type CompositeStepClassification = "landed" | "not_applied" | "unknown";

export type CompositeRecoveryDecision = "roll_forward" | "abort" | "rollback" | "orphan";

export interface ObservedCompositeStep {
  step: StepIntent;
  target: ResolvedPath;
  actualHash: ContentHash | null;
  classification: CompositeStepClassification;
}

/** Classifies one recovery step only from its immutable hashes and the currently observed target hash. */
export function classifyCompositeStep(
  step: StepIntent,
  actualHash: ContentHash | null,
): CompositeStepClassification {
  if (step.kind === "delete") {
    if (actualHash === null) return "landed";
    return actualHash === step.fromHash ? "not_applied" : "unknown";
  }
  if (actualHash === step.toHash) return "landed";
  if (actualHash === step.fromHash) return "not_applied";
  return "unknown";
}

/** Reduces ordered filesystem observations into the only safe recovery action. */
export function decideCompositeRecovery(
  classifications: readonly CompositeStepClassification[],
): CompositeRecoveryDecision {
  if (classifications.length === 0 || classifications.includes("unknown")) return "orphan";
  if (classifications.every((classification) => classification === "landed")) return "roll_forward";
  if (classifications.every((classification) => classification === "not_applied")) return "abort";
  return "rollback";
}

/** Restores landed steps in descending ordinal order and proves each target returned to its original state. */
export async function rollbackObservedCompositeSteps(
  workspace: WorkspacePort,
  observations: readonly ObservedCompositeStep[],
  journalId?: JournalId,
): Promise<boolean> {
  const landed = observations
    .filter((observation) => observation.classification === "landed")
    .sort((left, right) => right.step.ordinal - left.step.ordinal);
  for (const observation of landed) {
    const { step, target } = observation;
    try {
      if (journalId !== undefined) {
        if (step.fromHash !== null && step.previousContent === null) return false;
        const captured = await workspace.captureForMutation(
          target,
          observation.actualHash,
          journalId,
          step.ordinal + 1_000_000,
        );
        if (!captured.ok) return false;
        const restored = await workspace.publishCaptured(
          captured.value,
          step.fromHash === null ? null : step.previousContent,
        );
        if (!restored || await workspace.readHash(target) !== step.fromHash) {
          await workspace.restoreCaptured(captured.value, null).catch(() => false);
          return false;
        }
        await workspace.discardCapture(captured.value);
        continue;
      }
      if (step.fromHash === null) {
        await workspace.deleteAtomic(target);
      } else {
        if (step.previousContent === null) return false;
        await workspace.writeAtomic(target, step.previousContent);
      }
      if (await workspace.readHash(target) !== step.fromHash) return false;
    } catch {
      return false;
    }
  }
  return true;
}
