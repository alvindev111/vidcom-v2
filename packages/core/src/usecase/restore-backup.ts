import { ErrorCode, type Actor, type DomainError, type PreviewSettingsPatchDto, type ProjectId, type RelPath } from "@vidcom/contracts";

import { normalizePreviewSettings } from "../domain/preview-settings";
import { err, type Result } from "../error/result";
import type { BackupPort, CompositeMutationJournalPort, WorkspacePort } from "../port/ports";
import type { BackupPayload, CompositeRequest, CompositeStep, WriteEnvelope } from "../port/types";

export interface RestoreBackupDependencies {
  backups: BackupPort;
  journal: Pick<CompositeMutationJournalPort, "readBackupRevisionSteps" | "readEntityState">;
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readFile">;
  writes: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
}

function failure(code: ErrorCode, message: string): Result<never, DomainError> {
  return err({ code, message });
}

function payloadMap(payloads: BackupPayload[]): Map<RelPath, BackupPayload> {
  return new Map(payloads.map((payload) => [payload.path, payload]));
}

/** Restores one verified destructive backup as a new preconditioned composite revision. */
export async function restoreBackup(
  dependencies: RestoreBackupDependencies,
  input: { projectId: ProjectId; backupId: string },
  actor: "cli-external",
): Promise<Result<WriteEnvelope, DomainError>> {
  const [manifest, ref] = await Promise.all([
    dependencies.backups.read(input.backupId),
    dependencies.workspace.readProjectRef(input.projectId),
  ]);
  if (!ref) return failure(ErrorCode.ProjectNotFound, "project was not found");
  if (!manifest || manifest.projectId !== input.projectId) {
    return failure(ErrorCode.NotFound, "backup was not found for this project");
  }
  if (manifest.payloadPrunedAt !== null) {
    return failure(ErrorCode.BackupExpired, "backup payload retention has expired");
  }
  if (manifest.revisionId === null) {
    return failure(ErrorCode.BackupFailed, "backup is not linked to a destructive revision");
  }
  if (!(await dependencies.backups.verify(input.backupId))) {
    return failure(ErrorCode.BackupFailed, "backup payload integrity verification failed");
  }

  let payloads: BackupPayload[];
  try {
    payloads = await dependencies.backups.readPayloads(input.backupId);
  } catch {
    return failure(ErrorCode.BackupFailed, "backup payload integrity verification failed");
  }
  const backedUp = payloadMap(payloads);
  const destructiveSteps = await dependencies.journal.readBackupRevisionSteps(
    input.backupId,
    manifest.revisionId,
  );
  if (destructiveSteps.length === 0) {
    return failure(ErrorCode.BackupFailed, "backup has no linked destructive revision steps");
  }

  const restoreSteps: CompositeStep[] = [];
  for (const step of destructiveSteps) {
    if (step.kind === "entity") {
      const state = await dependencies.journal.readEntityState(input.projectId, step.entity);
      if (!state) return failure(ErrorCode.BackupFailed, "backup entity state is unavailable");
      if (state.contentHash !== step.toHash) {
        return failure(ErrorCode.WriteConflict, "project changed after the destructive revision");
      }
      const payload = backedUp.get(state.backingPath);
      if (!payload || payload.contentHash !== step.fromHash) {
        return failure(ErrorCode.BackupFailed, "backup is missing the prior entity payload");
      }
      let previous;
      try {
        previous = normalizePreviewSettings(JSON.parse(new TextDecoder().decode(payload.bytes)));
      } catch {
        return failure(ErrorCode.BackupFailed, "backup entity payload is invalid");
      }
      const resolved = await dependencies.workspace.resolve(ref, state.backingPath, "system-write");
      if (!resolved.ok) return failure(ErrorCode.BackupFailed, "backup entity target is no longer writable");
      const currentFile = await dependencies.workspace.readFile(resolved.value);
      if (currentFile?.contentHash !== step.toHash) {
        return failure(ErrorCode.WriteConflict, "project changed after the destructive revision");
      }
      let current;
      try {
        current = normalizePreviewSettings(currentFile ? JSON.parse(currentFile.content) : null);
      } catch {
        return failure(ErrorCode.WriteConflict, "current entity content is no longer canonical");
      }
      const patch: PreviewSettingsPatchDto = {
        tone: previous.tone,
        theme: previous.theme,
        bgm: previous.bgm,
        subtitles: previous.subtitles,
        scenes: previous.scenes,
        scenesRemove: Object.keys(current.scenes).filter((sceneId) => !(sceneId in previous.scenes)),
      };
      restoreSteps.push({
        kind: "entity",
        entity: step.entity,
        patch,
        expectedRevision: state.revision,
      });
      continue;
    }

    if (step.fromHash === null) {
      if (step.kind !== "write") {
        return failure(ErrorCode.BackupFailed, "backup revision contains an invalid absent-source step");
      }
      restoreSteps.push({ kind: "delete", path: step.path, expectedContentHash: step.toHash });
      continue;
    }
    const payload = backedUp.get(step.path);
    if (!payload || payload.contentHash !== step.fromHash) {
      return failure(ErrorCode.BackupFailed, "backup is missing a prior file payload");
    }
    restoreSteps.push({
      kind: "write",
      path: step.path,
      content: payload.bytes,
      expectedContentHash: step.toHash,
    });
  }

  return dependencies.writes.mutateSource({
    ref,
    steps: restoreSteps,
    toolAudit: null,
    commandAudit: { action: "cli:restore", detail: { backupId: input.backupId } },
    backup: false,
  }, actor);
}
