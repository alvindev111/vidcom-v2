import { ErrorCode, type ContentHash, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";

import { DEFAULT_PREVIEW_SETTINGS, serializePreviewSettings } from "../domain/preview-settings";
import type { AbsolutePath, ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { ClockPort, IdPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { ProjectRegistration } from "../port/types";
import type { WriteAuthority } from "../service/write-authority";

/** Marker-backed project directory discovered before stable identity is known. */
export interface ProjectCandidate {
  workspaceRoot: AbsolutePath;
  root: AbsolutePath;
  slug: string;
  entry: RelPath;
}

/** Dependencies for idempotent identity registration and backfill. */
export interface BootstrapProjectDependencies {
  workspace: WorkspacePort;
  journal: MutationJournalPort;
  authority: WriteAuthority;
  clock: ClockPort;
  ids: IdPort;
  hashContent(content: string | Uint8Array): ContentHash;
  registrationLocationExists(registration: ProjectRegistration): Promise<boolean>;
}

/** Result of opening, moving, creating or de-duplicating one project identity. */
export interface BootstrapProjectResult {
  ref: ProjectRef;
  identityCreated: boolean;
  duplicateReassigned: boolean;
}

function identityFrom(content: string | null): ProjectId | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.length > 0 ? (parsed.id as ProjectId) : null;
  } catch {
    return null;
  }
}

/** Registers a project, preserving moved IDs and journal-writing missing or duplicated identities. */
export async function bootstrapProject(
  dependencies: BootstrapProjectDependencies,
  candidate: ProjectCandidate,
): Promise<Result<BootstrapProjectResult, DomainError>> {
  const provisional: ProjectRef = {
    id: "pending" as ProjectId,
    slug: candidate.slug,
    root: candidate.root,
    entry: candidate.entry,
  };
  const identityPath = "vidcom.json" as RelPath;
  const identityResolved = await dependencies.workspace.resolve(provisional, identityPath, "system-write");
  if (!identityResolved.ok) {
    return err({ code: ErrorCode.PathOutsideProject, message: "project identity path is unavailable" });
  }
  const identityFile = await dependencies.workspace.readFile(identityResolved.value);
  const originalId = identityFrom(identityFile?.content ?? null);
  let projectId = originalId ?? (dependencies.ids.newId("project") as ProjectId);
  let duplicateReassigned = false;
  const existingRegistration = originalId
    ? await dependencies.journal.findProjectRegistration(originalId)
    : null;
  if (
    existingRegistration &&
    (existingRegistration.workspaceRoot !== candidate.workspaceRoot || existingRegistration.slug !== candidate.slug) &&
    (await dependencies.registrationLocationExists(existingRegistration))
  ) {
    projectId = dependencies.ids.newId("project") as ProjectId;
    duplicateReassigned = true;
  }

  const ref: ProjectRef = { ...provisional, id: projectId };
  const previewPath = "preview-settings.json" as RelPath;
  const previewResolved = await dependencies.workspace.resolve(ref, previewPath, "system-write");
  if (!previewResolved.ok) {
    return err({ code: ErrorCode.PathOutsideProject, message: "preview settings path is unavailable" });
  }
  const previewHash = await dependencies.workspace.readHash(previewResolved.value);
  const now = dependencies.clock.now().toISOString();
  const seed = {
    revision: previewHash ? 1 : 0,
    contentHash:
      previewHash ?? dependencies.hashContent(serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS)),
    backingPath: previewPath,
    actor: "system" as const,
    updatedAt: now,
  };
  const registration: ProjectRegistration = {
    id: projectId,
    workspaceRoot: candidate.workspaceRoot,
    slug: candidate.slug,
    firstSeenAt: existingRegistration?.firstSeenAt ?? now,
    lastSeenAt: now,
  };
  const identityNeedsWrite = originalId !== projectId;
  if (!identityNeedsWrite) {
    await dependencies.journal.registerProject(registration, seed);
    return ok({ ref, identityCreated: false, duplicateReassigned: false });
  }

  const content = `${JSON.stringify({ id: projectId }, null, 2)}\n`;
  const toHash = dependencies.hashContent(content);
  const intent = {
    projectId,
    kind: "file" as const,
    path: identityPath,
    entity: null,
    fromHash: identityFile?.contentHash ?? null,
    previousContent: identityFile?.content ?? null,
    toHash,
    actor: "system" as const,
  };
  const journalId = await dependencies.journal.beginBootstrap(
    registration,
    seed,
    intent,
    duplicateReassigned ? originalId : null,
  );
  const written = await dependencies.authority.completeBootstrapIdentity({
    ref,
    journalId,
    content,
    previousContent: identityFile?.content ?? null,
    fromHash: intent.fromHash,
    toHash,
  });
  return written.ok
    ? ok({ ref, identityCreated: originalId === null, duplicateReassigned })
    : written;
}
