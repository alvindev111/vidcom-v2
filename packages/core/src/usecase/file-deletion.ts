import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type Diagnostic,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { checkPathPurpose, checkPathSyntax } from "../domain/path-policy";
import { err, ok, type Result } from "../error/result";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { CompositeRequest, GrantBinding, WriteEnvelope, WriteInvocation } from "../port/types";
import { canonicalizeJson } from "../service/canonical-json";

export interface FileDeletionPlan {
  path: RelPath;
  expectedContentHash: ContentHash;
  targetHashes: Record<RelPath, ContentHash>;
  diagnostics: Diagnostic[];
}

export interface PrepareFileDeletionDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readHash">;
  composition: Pick<CompositionPort, "parseProject">;
  journal: Pick<MutationJournalPort, "latestRevision">;
  hashContent(content: string | Uint8Array): ContentHash;
}

function referencedByComposition(model: Awaited<ReturnType<CompositionPort["parseProject"]>>, path: RelPath): boolean {
  return model.references.some((reference) => reference.path === path);
}

/** Plans one file deletion without writing or reserving a grant. */
export async function prepareFileDeletion(
  dependencies: PrepareFileDeletionDependencies,
  input: { projectId: ProjectId; path: RelPath; expectedContentHash: ContentHash },
): Promise<Result<{ plan: FileDeletionPlan; binding: GrantBinding }, DomainError>> {
  try {
    const ref = await dependencies.workspace.readProjectRef(input.projectId);
    if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
    if (checkPathSyntax(input.path) || checkPathPurpose(input.path, "write-source")) {
      return err({ code: ErrorCode.AssetNotAllowed, message: "the path is not an allowed composition source" });
    }
    const target = await dependencies.workspace.resolve(ref, input.path, "write-source");
    if (!target.ok) return err({ code: ErrorCode.AssetNotAllowed, message: "the deletion path was rejected" });
    const [currentHash, model, latestRevision] = await Promise.all([
      dependencies.workspace.readHash(target.value),
      dependencies.composition.parseProject(ref),
      dependencies.journal.latestRevision(input.projectId),
    ]);
    if (currentHash === null) return err({ code: ErrorCode.NotFound, message: "file was not found" });
    if (currentHash !== input.expectedContentHash) {
      return err({
        code: ErrorCode.WriteConflict,
        message: "file changed before deletion planning",
        details: { current: { contentHash: currentHash, revision: latestRevision ?? 0 } },
      });
    }
    if (referencedByComposition(model, input.path)) {
      return err({
        code: ErrorCode.ReferencedByComposition,
        message: "file is still referenced by the composition",
      });
    }
    const plan: FileDeletionPlan = {
      path: input.path,
      expectedContentHash: currentHash,
      targetHashes: { [input.path]: currentHash },
      diagnostics: [],
    };
    const binding: GrantBinding = {
      tool: "delete_file",
      projectId: input.projectId,
      target: input.path,
      expectedRevision: latestRevision ?? 0,
      planDigest: dependencies.hashContent(canonicalizeJson(plan)),
      targetHashes: plan.targetHashes,
    };
    return ok({ plan, binding });
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "file deletion could not be planned" });
  }
}

export interface DeleteFileDependencies extends PrepareFileDeletionDependencies {
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
}

/** Re-plans and executes only the approved file deletion with backup and one-shot grant reservation. */
export async function deleteFile(
  dependencies: DeleteFileDependencies,
  input: { projectId: ProjectId; plan: FileDeletionPlan; grantId: string },
  actor: Actor,
  invocation: WriteInvocation = { origin: ignoredMutationOriginForActor(actor), toolAudit: null },
): Promise<Result<{ deleted: RelPath; envelope: WriteEnvelope; backupId: string }, DomainError>> {
  const prepared = await prepareFileDeletion(dependencies, {
    projectId: input.projectId,
    path: input.plan.path,
    expectedContentHash: input.plan.expectedContentHash,
  });
  if (!prepared.ok) return prepared;
  if (canonicalizeJson(prepared.value.plan) !== canonicalizeJson(input.plan)) {
    return err({ code: ErrorCode.ApprovalInvalid, message: "approved deletion plan no longer matches" });
  }
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const written = await dependencies.authority.mutateSource({
    ref,
    steps: [{
      kind: "delete",
      path: input.plan.path,
      expectedContentHash: input.plan.expectedContentHash,
    }],
    ...invocation,
    diagnostics: input.plan.diagnostics,
    backup: true,
    grant: { id: input.grantId, binding: prepared.value.binding },
  }, actor);
  if (!written.ok) return written;
  const backupId = "backupId" in written.value && typeof written.value.backupId === "string"
    ? written.value.backupId
    : null;
  if (!backupId) return err({ code: ErrorCode.BackupFailed, message: "destructive mutation returned no backup ID" });
  return ok({
    deleted: input.plan.path,
    envelope: {
      projectRevision: written.value.projectRevision,
      entityRevision: written.value.entityRevision,
      fileHashes: written.value.fileHashes,
      diagnostics: written.value.diagnostics,
      changeSeq: written.value.changeSeq,
    },
    backupId,
  });
}
