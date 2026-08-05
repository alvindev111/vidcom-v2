import { ErrorCode, type Actor, type ContentHash, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";

import { inferPreset, rootCompositionSource, type PlatformConfig } from "../domain/platform-preset";
import { DEFAULT_PREVIEW_SETTINGS, serializePreviewSettings } from "../domain/preview-settings";
import type { AbsolutePath, ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { BackupPort, ClockPort, CompositionPort, IdPort, JobStorePort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { BackupSource, GrantBinding } from "../port/types";
import { canonicalizeJson } from "../service/canonical-json";
import type { EntryId, EntryRegistry } from "../service/entry-registry";
import type { WriteAuthority } from "../service/write-authority";
import type { ProjectIdentity, ProjectIdentityService } from "./project-identity";

export type ProjectLocator =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "entry"; entryId: EntryId };

export interface ProjectLifecycleDependencies {
  workspaceRoot: AbsolutePath;
  workspace: WorkspacePort;
  authority: Pick<WriteAuthority,
    "createProjectRoot" | "renameProjectRoot" | "deleteProjectRoot" | "adoptProjectIdentity">;
  backups: BackupPort;
  jobs: JobStorePort & Required<Pick<JobStorePort, "listProjectJobs">>;
  entries: EntryRegistry;
  identity: ProjectIdentityService;
  composition: CompositionPort;
  ids: IdPort;
  clock: ClockPort;
  registrations: MutationJournalPort;
  approvals: { planReserve(grantId: string, binding: GrantBinding): Promise<Result<{ kind: "reserve"; grantId: string; binding: GrantBinding }, DomainError>> };
  hashContent(content: string | Uint8Array): ContentHash;
}

export type ProjectRemovalAuthority =
  | { actor: "user"; confirmed: true }
  | { actor: "agent" | "cli-external"; confirmed: true; grantId: string };

interface LifecycleTarget {
  projectId: ProjectId | null;
  slug: string;
  root: AbsolutePath;
  entry: RelPath;
}

function slugify(name: string): string | null {
  const slug = name.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(slug) ? slug : null;
}

function identityFor(
  id: ProjectId,
  platform: PlatformConfig | null,
  now: string,
): ProjectIdentity {
  return {
    schemaVersion: 1,
    id,
    platform,
    render: { defaultPresetId: platform?.presetId ?? "horizontal-youtube", outputDirectory: "renders" },
    narration: { defaultProviderId: null, defaultVoiceId: null },
    createdAt: now,
    updatedAt: now,
  };
}

/** Project directory lifecycle; every write delegates to the authority facade. */
export class ProjectLifecycle {
  constructor(private readonly dependencies: ProjectLifecycleDependencies) {}

  /** Validates a new project, journals its initial files, and commits one registry revision plus project event. */
  async create(input: { name: string; preset: PlatformConfig; actor?: Actor }): Promise<Result<{ projectId: ProjectId; slug: string }, DomainError>> {
    const slug = slugify(input.name);
    if (!slug) return err({ code: ErrorCode.SchemaInvalid, message: "project name cannot produce a valid slug", field: "name" });
    const projectId = this.dependencies.ids.newId("project") as ProjectId;
    const now = this.dependencies.clock.now().toISOString();
    const identity = this.dependencies.identity.serialize(identityFor(projectId, input.preset, now));
    const index = rootCompositionSource(input.preset);
    if (this.dependencies.composition.validateSource) {
      const valid = await this.dependencies.composition.validateSource("index.html" as RelPath, index);
      if (!valid.ok) return valid;
    }
    const created = await this.dependencies.authority.createProjectRoot({
      workspaceRoot: this.dependencies.workspaceRoot,
      projectId,
      slug,
      actor: input.actor ?? "user",
      files: [
        { path: "vidcom.json" as RelPath, content: identity },
        { path: "hyperframes.json" as RelPath, content: "{}\n" },
        { path: "preview-settings.json" as RelPath, content: serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS) },
        { path: "index.html" as RelPath, content: index },
      ],
    });
    return created.ok ? ok({ projectId, slug }) : created;
  }

  /** Adopts an unowned marker-backed folder by writing identity and committing its registry/event atomically. */
  async adopt(input: { slug: string; actor?: Actor }): Promise<Result<{ projectId: ProjectId }, DomainError>> {
    const directories = await this.dependencies.workspace.listWorkspaceDirectories?.(this.dependencies.workspaceRoot) ?? [];
    const candidate = directories.find((entry) => entry.slug === input.slug);
    if (!candidate) return err({ code: ErrorCode.ProjectNotFound, message: "project candidate was not found" });
    const [marker, currentIdentity, index] = await Promise.all([
      this.dependencies.workspace.statWorkspaceFile?.(candidate.root, "hyperframes.json") ?? null,
      this.dependencies.workspace.statWorkspaceFile?.(candidate.root, "vidcom.json") ?? null,
      this.dependencies.workspace.statWorkspaceFile?.(candidate.root, "index.html") ?? null,
    ]);
    if (!marker || currentIdentity) return err({ code: ErrorCode.WriteConflict, message: "folder is not an unadopted candidate" });
    const projectId = this.dependencies.ids.newId("project") as ProjectId;
    const ref: ProjectRef = {
      id: projectId,
      slug: input.slug,
      root: candidate.root,
      entry: "index.html" as RelPath,
    };
    let platform: PlatformConfig | null = null;
    if (index) {
      try {
        const model = await this.dependencies.composition.parseProject(ref);
        platform = inferPreset(model.project.width, model.project.height, 30);
      } catch {
        return err({ code: ErrorCode.CompositionParseError, message: "candidate composition could not be parsed" });
      }
    }
    const now = this.dependencies.clock.now().toISOString();
    const adopted = await this.dependencies.authority.adoptProjectIdentity({
      ref,
      workspaceRoot: this.dependencies.workspaceRoot,
      content: this.dependencies.identity.serialize(identityFor(projectId, platform, now)),
      occurredAt: now,
      actor: input.actor ?? "user",
    });
    return adopted.ok ? ok({ projectId }) : adopted;
  }

  /** Replaces an invalid recovery identity under a hash precondition and revokes the session entry on success. */
  async replaceIdentity(input: {
    entryId: EntryId;
    identity: ProjectIdentity;
    expectedContentHash: ContentHash;
    actor?: Actor;
  }): Promise<Result<{ projectId: ProjectId }, DomainError>> {
    const entry = this.dependencies.entries.resolve(input.entryId);
    if (!entry || entry.workspaceRoot !== this.dependencies.workspaceRoot) {
      return err({ code: ErrorCode.ProjectNotFound, message: "recovery entry is no longer valid" });
    }
    let content: string;
    try { content = this.dependencies.identity.serialize(input.identity); }
    catch { return err({ code: ErrorCode.SchemaInvalid, message: "replacement identity is invalid", field: "identity" }); }
    const ref: ProjectRef = {
      id: input.identity.id,
      slug: entry.slug,
      root: entry.root,
      entry: "index.html" as RelPath,
    };
    const written = await this.dependencies.authority.adoptProjectIdentity({
      ref,
      workspaceRoot: entry.workspaceRoot,
      content,
      occurredAt: this.dependencies.clock.now().toISOString(),
      actor: input.actor ?? "user",
      expectedContentHash: input.expectedContentHash,
    });
    if (!written.ok) return written;
    this.dependencies.entries.revoke(input.entryId);
    return ok({ projectId: input.identity.id });
  }

  private async project(locator: ProjectLocator): Promise<Result<LifecycleTarget, DomainError>> {
    if (locator.kind === "entry") {
      const entry = this.dependencies.entries.resolve(locator.entryId);
      if (!entry || entry.workspaceRoot !== this.dependencies.workspaceRoot) {
        return err({ code: ErrorCode.ProjectNotFound, message: "recovery entry is no longer valid" });
      }
      const registration = await this.dependencies.registrations.findProjectRegistrationAt?.(
        entry.workspaceRoot,
        entry.slug,
      ) ?? null;
      return ok({
        projectId: registration?.id ?? null,
        slug: entry.slug,
        root: entry.root,
        entry: "index.html" as RelPath,
      });
    }
    const ref = await this.dependencies.workspace.readProjectRef(locator.projectId);
    return ref
      ? ok({ projectId: ref.id, slug: ref.slug, root: ref.root, entry: ref.entry })
      : err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  }

  private async removalBinding(
    target: LifecycleTarget,
    sources: BackupSource[],
  ): Promise<Result<GrantBinding, DomainError>> {
    const hashes = await Promise.all(sources.map(async (source) => ({
      path: source.path,
      hash: await this.dependencies.workspace.readHash(source.resolved),
    })));
    if (hashes.some(({ hash }) => hash === null)) {
      return err({ code: ErrorCode.WriteConflict, message: "a project file changed while deletion was planned" });
    }
    const targetHashes = Object.fromEntries(hashes
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, hash }) => [path, hash!])) as Record<RelPath, ContentHash>;
    const expectedRevision = target.projectId === null
      ? 0
      : await this.dependencies.registrations.latestRevision(target.projectId) ?? 0;
    const owner = target.projectId
      ?? `location:${this.dependencies.hashContent(this.dependencies.workspaceRoot).slice(7, 23)}:${target.slug}`;
    const core = { tool: "delete_project", projectId: target.projectId, target: owner, expectedRevision, targetHashes };
    return ok({ ...core, planDigest: this.dependencies.hashContent(canonicalizeJson(core)) });
  }

  /** Hashes every deletion target without writing files, revisions, events, grants, or backups. */
  async planRemove(locator: ProjectLocator): Promise<Result<{ binding: GrantBinding; summary: string }, DomainError>> {
    const target = await this.project(locator);
    if (!target.ok) return target;
    const sources = target.value.projectId === null
      ? await this.dependencies.workspace.listBackupSourcesAt?.(target.value.root)
      : await this.dependencies.workspace.listBackupSources?.({
          id: target.value.projectId,
          slug: target.value.slug,
          root: target.value.root,
          entry: target.value.entry,
        });
    if (!sources?.length) return err({ code: ErrorCode.BackupFailed, message: "project backup sources are unavailable" });
    const binding = await this.removalBinding(target.value, sources);
    return binding.ok ? ok({ binding: binding.value, summary: `Delete project ${target.value.slug}` }) : binding;
  }

  /** Renames an idle project through the lifecycle journal and emits one project/workspace change event. */
  async rename(locator: ProjectLocator, nextName: string, actor: Actor = "user"): Promise<Result<{ slug: string }, DomainError>> {
    const ref = await this.project(locator);
    if (!ref.ok) return ref;
    const slug = slugify(nextName);
    if (!slug) return err({ code: ErrorCode.SchemaInvalid, message: "project name cannot produce a valid slug", field: "name" });
    if (ref.value.projectId !== null && await this.hasBlockingJob(ref.value.projectId)) {
      return err({ code: ErrorCode.WriteConflict, message: "a running project job blocks rename" });
    }
    const renamed = await this.dependencies.authority.renameProjectRoot({
      workspaceRoot: this.dependencies.workspaceRoot,
      projectId: ref.value.projectId,
      fromSlug: ref.value.slug,
      toSlug: slug,
      actor,
    });
    if (renamed.ok && locator.kind === "entry") {
      this.dependencies.entries.relocate(locator.entryId, slug, renamed.value.root);
    }
    return renamed.ok ? ok({ slug }) : renamed;
  }

  /** Requires confirmation/grant, verifies a backup, then journals quarantine and the delete revision/event. */
  async remove(locator: ProjectLocator, authority: ProjectRemovalAuthority): Promise<Result<{ backupId: string }, DomainError>> {
    if (!authority.confirmed) return err({
      code: ErrorCode.ConfirmationRequired,
      message: "project deletion requires explicit confirmation",
    });
    const ref = await this.project(locator);
    if (!ref.ok) return ref;
    if (ref.value.projectId !== null && await this.hasBlockingJob(ref.value.projectId)) {
      return err({ code: ErrorCode.WriteConflict, message: "a running project job blocks deletion" });
    }
    const sources = ref.value.projectId === null
      ? await this.dependencies.workspace.listBackupSourcesAt?.(ref.value.root)
      : await this.dependencies.workspace.listBackupSources?.({
          id: ref.value.projectId,
          slug: ref.value.slug,
          root: ref.value.root,
          entry: ref.value.entry,
        });
    if (!sources || sources.length === 0) {
      return err({ code: ErrorCode.BackupFailed, message: "project backup sources are unavailable" });
    }
    const binding = await this.removalBinding(ref.value, sources);
    if (!binding.ok) return binding;
    let grantId: string | undefined;
    if (authority.actor !== "user") {
      const planned = await this.dependencies.approvals.planReserve(authority.grantId, binding.value);
      if (!planned.ok) return planned;
      grantId = planned.value.grantId;
    }
    const backup = ref.value.projectId === null
      ? await this.dependencies.backups.createForLocation?.({
          workspaceRoot: this.dependencies.workspaceRoot,
          slug: ref.value.slug,
        }, "project-delete", sources)
      : await this.dependencies.backups.create(ref.value.projectId, "project-delete", sources);
    if (!backup) return err({ code: ErrorCode.BackupFailed, message: "location backup is unavailable" });
    if (!(await this.dependencies.backups.verify(backup.id))) {
      return err({ code: ErrorCode.BackupFailed, message: "project backup could not be verified" });
    }
    if (backup.entries.some((entry) => binding.value.targetHashes[entry.path] !== entry.contentHash)
      || backup.entries.length !== Object.keys(binding.value.targetHashes).length) {
      return err({ code: ErrorCode.WriteConflict, message: "project files changed after deletion approval" });
    }
    const removed = await this.dependencies.authority.deleteProjectRoot({
      workspaceRoot: this.dependencies.workspaceRoot,
      projectId: ref.value.projectId,
      slug: ref.value.slug,
      verifiedBackupId: backup.id,
      expectedTargetHashes: binding.value.targetHashes,
      actor: authority.actor,
      ...(grantId ? { grantId } : {}),
    });
    if (removed.ok && locator.kind === "entry") this.dependencies.entries.revoke(locator.entryId);
    return removed;
  }

  private async hasBlockingJob(projectId: ProjectId): Promise<boolean> {
    return this.dependencies.jobs.hasRunningProjectJob
      ? this.dependencies.jobs.hasRunningProjectJob(projectId)
      : (await this.dependencies.jobs.listProjectJobs(projectId)).some((job) => job.status === "running");
  }
}
