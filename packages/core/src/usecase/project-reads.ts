import {
  ErrorCode,
  MAX_SOURCE_BYTES,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
  type SceneDto,
} from "@vidcom/contracts";

import { normalizePreviewSettings } from "../domain/preview-settings";
import type { CompositionModel, FileNode, ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { CompositeMutationJournalPort, CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { PreviewSettings } from "../port/types";
import type { ProjectCache } from "../service/project-cache";

export interface ProjectReadDependencies {
  workspace: WorkspacePort;
  composition: CompositionPort;
  journal: MutationJournalPort & Pick<CompositeMutationJournalPort, "readProjectRecoveryStatus">;
  cache?: ProjectCache;
}

export interface SceneContext {
  id: string;
  src: string | null;
  start: number;
  duration: number;
  trackIndex: number;
  isTransition: boolean;
  elementCount: number;
  fileContentHash: ContentHash;
  narrationStale: boolean;
}

function parseProject(dependencies: ProjectReadDependencies, ref: ProjectRef): Promise<CompositionModel> {
  return dependencies.cache
    ? dependencies.cache.get(ref.id, () => dependencies.composition.parseProject(ref))
    : dependencies.composition.parseProject(ref);
}

async function projectRef(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
): Promise<Result<ProjectRef, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(projectId);
  return ref
    ? ok(ref)
    : err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
}

function readPathError(reason: "outside_project" | "not_allowed_for_purpose" | "symlink_escape" | "invalid_syntax"): DomainError {
  if (reason === "not_allowed_for_purpose") {
    return { code: ErrorCode.AssetNotAllowed, message: "the path is not an allowed composition source" };
  }
  if (reason === "invalid_syntax") return { code: ErrorCode.PathInvalid, message: "the path is invalid" };
  return { code: ErrorCode.PathOutsideProject, message: "the path resolves outside the project" };
}

function sceneContexts(
  scenes: SceneDto[],
  entry: RelPath,
  fileHashes: Record<string, ContentHash>,
): SceneContext[] {
  return scenes.map((scene: SceneDto) => {
    const source = scene.src ?? entry;
    const fileContentHash = fileHashes[source];
    if (!fileContentHash) throw new Error(`parsed scene source has no hash: ${source}`);
    return {
      id: scene.id,
      src: scene.src,
      start: scene.start,
      duration: scene.duration,
      trackIndex: scene.trackIndex,
      isTransition: scene.isTransition,
      elementCount: scene.elements.length,
      fileContentHash,
      narrationStale: scene.narration !== null && scene.narration.staleSince !== null,
    };
  });
}

function storageError(message: string): Result<never, DomainError> {
  return err({ code: ErrorCode.StorageUnavailable, message });
}

export async function listProjects(
  dependencies: ProjectReadDependencies,
): Promise<Result<CompositionModel["project"][], DomainError>> {
  try {
    const refs = await dependencies.workspace.listProjects();
    const projects = await Promise.all(refs.map(async (ref) => {
      const model = await parseProject(dependencies, ref);
      return {
        ...model.project,
        revision: (await dependencies.journal.latestRevision(ref.id)) ?? 0,
      };
    }));
    return ok(projects);
  } catch {
    return storageError("projects could not be read");
  }
}

/** Lists bounded MCP project summaries with revision and recovery visibility, never filesystem roots. */
export async function listProjectContexts(dependencies: ProjectReadDependencies) {
  try {
    const refs = await dependencies.workspace.listProjects();
    const projects = await Promise.all(refs.map(async (ref) => {
      const [model, projectRevision, recovery] = await Promise.all([
        parseProject(dependencies, ref),
        dependencies.journal.latestRevision(ref.id),
        dependencies.journal.readProjectRecoveryStatus(ref.id),
      ]);
      return {
        projectId: ref.id,
        slug: ref.slug,
        title: model.project.title,
        width: model.project.width,
        height: model.project.height,
        duration: model.project.duration,
        projectRevision: projectRevision ?? 0,
        recovery,
      };
    }));
    return ok(projects);
  } catch {
    return storageError("project contexts could not be read");
  }
}

export async function readSourceFile(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
  path: RelPath,
) {
  try {
    const found = await projectRef(dependencies, projectId);
    if (!found.ok) return found;
    const resolved = await dependencies.workspace.resolve(found.value, path, "read-source");
    if (!resolved.ok) return err(readPathError(resolved.error.reason));
    const metadata = await dependencies.workspace.stat(resolved.value);
    if (metadata?.kind === "file" && metadata.size > MAX_SOURCE_BYTES) {
      return err({ code: ErrorCode.TooLarge, message: `source content exceeds ${MAX_SOURCE_BYTES} bytes` });
    }
    const file = await dependencies.workspace.readFile(resolved.value);
    return file
      ? ok({ path, content: file.content, contentHash: file.contentHash })
      : err({ code: ErrorCode.NotFound, message: "source file was not found" });
  } catch {
    return storageError("source file could not be read");
  }
}

/** Returns the bounded agent context required to plan all MCP mutations. */
export async function getProjectContext(dependencies: ProjectReadDependencies, projectId: ProjectId) {
  const snapshot = await getStudioSnapshot(dependencies, projectId);
  if (!snapshot.ok) return snapshot;
  return ok({
    project: snapshot.value.project,
    scenes: sceneContexts(snapshot.value.scenes, snapshot.value.entryFile.path, snapshot.value.fileHashes),
    rootTrack: snapshot.value.rootTrack,
    previewSettings: snapshot.value.previewSettings,
    entityRevision: snapshot.value.entityRevision,
    projectRevision: snapshot.value.projectRevision,
    diagnostics: snapshot.value.diagnostics,
    fileHashes: snapshot.value.fileHashes,
    recovery: snapshot.value.recovery,
  });
}

/** Returns only compact scene preconditions and recovery state for low-token MCP reads. */
export async function listSceneContexts(dependencies: ProjectReadDependencies, projectId: ProjectId) {
  const context = await getProjectContext(dependencies, projectId);
  return context.ok
    ? ok({ scenes: context.value.scenes, projectRevision: context.value.projectRevision, recovery: context.value.recovery })
    : context;
}

/** Reads one allowlisted bounded composition source together with the current recovery gate. */
export async function readComposition(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
  path: RelPath,
) {
  const file = await readSourceFile(dependencies, projectId, path);
  if (!file.ok) return file;
  try {
    const recovery = await dependencies.journal.readProjectRecoveryStatus(projectId);
    return ok({ ...file.value, recovery });
  } catch {
    return storageError("project recovery state could not be read");
  }
}

export async function readAsset(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
  path: RelPath,
) {
  try {
    const found = await projectRef(dependencies, projectId);
    if (!found.ok) return found;
    const resolved = await dependencies.workspace.resolve(found.value, path, "read-asset");
    if (!resolved.ok) return err({ code: ErrorCode.AssetNotAllowed, message: "asset path was rejected" });
    const asset = await dependencies.workspace.readBytes(resolved.value);
    return asset
      ? ok({ path, ...asset })
      : err({ code: ErrorCode.NotFound, message: "asset was not found" });
  } catch {
    return storageError("asset could not be read");
  }
}

export async function getPreviewSettings(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
): Promise<Result<{ previewSettings: PreviewSettings; revision: number }, DomainError>> {
  try {
    const found = await projectRef(dependencies, projectId);
    if (!found.ok) return found;
    const state = await dependencies.journal.readEntityState(projectId, "preview-settings");
    if (!state) return storageError("preview settings have not been initialized");
    const resolved = await dependencies.workspace.resolve(found.value, state.backingPath, "system-write");
    if (!resolved.ok) return storageError("preview settings path is unavailable");
    const file = await dependencies.workspace.readFile(resolved.value);
    let raw: unknown = null;
    if (file) {
      try { raw = JSON.parse(file.content); } catch { raw = null; }
    }
    return ok({ previewSettings: normalizePreviewSettings(raw), revision: state.revision });
  } catch {
    return storageError("preview settings could not be read");
  }
}

export async function resolveProjectIdBySlug(
  dependencies: ProjectReadDependencies,
  slug: string,
): Promise<Result<ProjectId, DomainError>> {
  try {
    const ref = (await dependencies.workspace.listProjects()).find((candidate) => candidate.slug === slug);
    return ref
      ? ok(ref.id)
      : err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  } catch {
    return storageError("project could not be resolved");
  }
}

export async function getProjectPreview(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
  options: { runtimeUrl: string; fileBaseUrl: string },
): Promise<Result<{ html: string }, DomainError>> {
  try {
    const found = await projectRef(dependencies, projectId);
    if (!found.ok) return found;
    const settings = await getPreviewSettings(dependencies, projectId);
    if (!settings.ok) return settings;
    const html = await dependencies.composition.buildDocument(
      found.value,
      settings.value.previewSettings,
      { root: true, ...options },
    );
    return ok({ html });
  } catch {
    return storageError("project preview could not be built");
  }
}

export interface StudioSnapshot {
  project: CompositionModel["project"];
  entryFile: { path: RelPath; content: string; contentHash: string };
  tree: FileNode[];
  scenes: CompositionModel["scenes"];
  rootTrack: unknown | null;
  previewSettings: PreviewSettings;
  previewSettingsRevision: number;
  revision: number;
  projectRevision: number;
  entityRevision: number;
  fileHashes: Record<string, ContentHash>;
  recovery: Awaited<ReturnType<CompositeMutationJournalPort["readProjectRecoveryStatus"]>>;
  diagnostics: CompositionModel["diagnostics"];
}

export async function getStudioSnapshot(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
): Promise<Result<StudioSnapshot, DomainError>> {
  try {
    const found = await projectRef(dependencies, projectId);
    if (!found.ok) return found;
    const [model, entry, tree, settings, projectRevision, recovery] = await Promise.all([
      parseProject(dependencies, found.value),
      readSourceFile(dependencies, projectId, found.value.entry),
      dependencies.workspace.readTree(found.value),
      getPreviewSettings(dependencies, projectId),
      dependencies.journal.latestRevision(projectId),
      dependencies.journal.readProjectRecoveryStatus(projectId),
    ]);
    if (!entry.ok) return entry;
    if (!settings.ok) return settings;
    const revision = projectRevision ?? 0;
    const fileHashes = Object.fromEntries(model.sources.map((source) => [source.path, source.contentHash]));
    return ok({
      project: { ...model.project, revision },
      entryFile: entry.value,
      tree,
      scenes: model.scenes,
      rootTrack: model.rootTrack,
      previewSettings: settings.value.previewSettings,
      previewSettingsRevision: settings.value.revision,
      revision,
      projectRevision: revision,
      entityRevision: settings.value.revision,
      fileHashes,
      recovery,
      diagnostics: model.diagnostics,
    });
  } catch {
    return storageError("studio snapshot could not be built");
  }
}
