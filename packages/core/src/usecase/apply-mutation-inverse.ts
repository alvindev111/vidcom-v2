import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type PreviewSettingsDto,
  type PreviewSettingsPatchDto,
  type ProjectId,
} from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import type { MutationOrigin, MutationReceipt, MutationReceiptStep, UndoContentRef } from "../port/mutation-observer";
import type { CompositeStep, PendingMountTransition, StagedFileSource, WriteEnvelope } from "../port/types";
import type { ProjectWriteDependencies } from "./project-writes";

type Direction = "undo" | "redo";

function staged(value: Uint8Array | StagedFileSource): value is StagedFileSource {
  return !(value instanceof Uint8Array);
}

function targetContent(
  step: Extract<MutationReceiptStep, { kind: "file"; undoable: true }>,
  direction: Direction,
): { ref: UndoContentRef | null; expectedCurrent: ContentHash | null; targetHash: ContentHash | null } {
  return direction === "undo"
    ? { ref: step.beforeContent, expectedCurrent: step.toHash, targetHash: step.fromHash }
    : { ref: step.afterContent, expectedCurrent: step.fromHash, targetHash: step.toHash };
}

async function inverseFileStep(
  dependencies: ProjectWriteDependencies,
  step: Extract<MutationReceiptStep, { kind: "file"; undoable: true }>,
  direction: Direction,
): Promise<Result<CompositeStep, DomainError>> {
  const target = targetContent(step, direction);
  if (target.ref === null) {
    if (target.expectedCurrent === null) {
      return err({ code: ErrorCode.InvariantViolated, message: "history cannot delete an already absent file" });
    }
    return ok({ kind: "delete", path: step.path, expectedContentHash: target.expectedCurrent });
  }
  if (target.targetHash === null || target.ref.contentHash !== target.targetHash) {
    return err({ code: ErrorCode.IntegrityMismatch, message: "history content does not match its target hash" });
  }
  if (!dependencies.undoContent) {
    return err({ code: ErrorCode.StorageUnavailable, message: "history content storage is unavailable" });
  }
  let resolved: Uint8Array | StagedFileSource;
  try {
    resolved = await dependencies.undoContent.resolve(target.ref);
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "history content could not be resolved" });
  }
  if (staged(resolved)) {
    if (resolved.contentHash !== target.targetHash) {
      return err({ code: ErrorCode.IntegrityMismatch, message: "staged history content changed" });
    }
    return ok({
      kind: "write-staged",
      path: step.path,
      source: resolved,
      expectedContentHash: target.expectedCurrent,
      undoable: true,
    });
  }
  let content: string | Uint8Array = resolved;
  if (target.ref.encoding === "utf8") {
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(resolved); }
    catch { return err({ code: ErrorCode.IntegrityMismatch, message: "history text is not valid UTF-8" }); }
  }
  return ok({ kind: "write", path: step.path, content, expectedContentHash: target.expectedCurrent });
}

function inverseDirectoryStep(
  step: Extract<MutationReceiptStep, { kind: "directory" }>,
  direction: Direction,
): CompositeStep | null {
  if (direction === "undo") {
    if (step.op === "mkdir") {
      return step.existedBefore ? null : { kind: "rmdir", path: step.path, expectEmpty: true };
    }
    return { kind: "mkdir", path: step.path, expectExisting: "absent" };
  }
  if (step.op === "mkdir") {
    return step.existedBefore ? null : { kind: "mkdir", path: step.path, expectExisting: "absent" };
  }
  return { kind: "rmdir", path: step.path, expectEmpty: true };
}

function fullStatePatch(current: PreviewSettingsDto, target: PreviewSettingsDto): PreviewSettingsPatchDto {
  const scenesRemove = Object.keys(current.scenes).filter((sceneId) => !(sceneId in target.scenes));
  return {
    tone: target.tone,
    theme: target.theme.paletteId === null
      ? { paletteId: null, variables: target.theme.variables }
      : { paletteId: target.theme.paletteId },
    bgm: target.bgm,
    subtitles: target.subtitles,
    scenes: target.scenes,
    ...(scenesRemove.length === 0 ? {} : { scenesRemove }),
  };
}

function pendingTransition(
  step: Extract<MutationReceiptStep, { kind: "pending-mount" }>,
  direction: Direction,
): PendingMountTransition {
  return direction === "undo"
    ? {
        kind: "reopen",
        operationId: step.operationId,
        expectedSceneId: step.after.sceneId,
        restoreFailure: step.before.lastFailure,
      }
    : {
        kind: "close",
        operationId: step.operationId,
        sceneId: step.after.sceneId,
        previousFailure: step.before.lastFailure,
      };
}

export async function applyMutationInverse(
  dependencies: ProjectWriteDependencies,
  input: { projectId: ProjectId; receipt: MutationReceipt; direction: Direction },
  actor: Actor,
  origin: MutationOrigin,
): Promise<Result<{ envelope: WriteEnvelope; inverse: MutationReceipt }, DomainError>> {
  if (input.receipt.projectId !== input.projectId || input.receipt.id !== origin.historyOperation?.targetReceiptId
    || origin.historyAction !== input.direction) {
    return err({ code: ErrorCode.SchemaInvalid, message: "history operation does not match its receipt" });
  }
  if (!input.receipt.undoable || input.receipt.steps.some((step) => !step.undoable)) {
    return err({ code: ErrorCode.WriteConflict, message: "history receipt is not undoable" });
  }
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });

  const ordered = input.direction === "undo" ? [...input.receipt.steps].reverse() : input.receipt.steps;
  const steps: CompositeStep[] = [];
  let transition: PendingMountTransition | undefined;
  for (const receiptStep of ordered) {
    if (receiptStep.kind === "file") {
      if (!receiptStep.undoable) return err({ code: ErrorCode.WriteConflict, message: "history file is not undoable" });
      const planned = await inverseFileStep(dependencies, receiptStep, input.direction);
      if (!planned.ok) return planned;
      steps.push(planned.value);
      continue;
    }
    if (receiptStep.kind === "directory") {
      const planned = inverseDirectoryStep(receiptStep, input.direction);
      if (planned) steps.push(planned);
      continue;
    }
    if (receiptStep.kind === "entity") {
      const state = input.direction === "undo" ? receiptStep.afterState : receiptStep.beforeState;
      const target = input.direction === "undo" ? receiptStep.beforeState : receiptStep.afterState;
      const expectedContentHash = input.direction === "undo" ? receiptStep.toHash : receiptStep.fromHash;
      if (!state || !target || expectedContentHash === null) {
        return err({ code: ErrorCode.InvariantViolated, message: "history entity state is incomplete" });
      }
      let current;
      try { current = await dependencies.journal.readEntityState(input.projectId, receiptStep.entity); }
      catch { return err({ code: ErrorCode.StorageUnavailable, message: "history entity state could not be read" }); }
      if (!current) return err({ code: ErrorCode.StorageUnavailable, message: "history entity state is unavailable" });
      steps.push({
        kind: "entity",
        entity: receiptStep.entity,
        patch: fullStatePatch(state, target),
        expectedRevision: current.revision,
        expectedContentHash,
        undoable: true,
      });
      continue;
    }
    if (transition) return err({ code: ErrorCode.InvariantViolated, message: "history has multiple pending mount transitions" });
    transition = pendingTransition(receiptStep, input.direction);
  }

  const written = await dependencies.authority.mutateSource({
    ref,
    steps,
    origin,
    historyReadGuards: input.direction === "redo" ? input.receipt.readGuards : [],
    ...(transition === undefined ? {} : { pendingMountTransition: transition }),
    toolAudit: null,
    backup: steps.some((step) => step.kind === "delete")
      || input.receipt.steps.some((step) => step.kind === "file" && step.undoable && step.afterContent === null),
  }, actor);
  if (!written.ok) return written;
  if (!written.value.inverseReceipt) {
    return err({ code: ErrorCode.Internal, message: "inverse mutation receipt was not returned" });
  }
  return ok({ envelope: written.value, inverse: written.value.inverseReceipt });
}
