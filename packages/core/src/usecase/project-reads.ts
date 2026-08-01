import { ErrorCode, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";

import { normalizePreviewSettings } from "../domain/preview-settings";
import type { CompositionModel, FileNode, ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { CompositionPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import type { PreviewSettings } from "../port/types";
import type { ProjectCache } from "../service/project-cache";

export interface ProjectReadDependencies {
  workspace: WorkspacePort;
  composition: CompositionPort;
  journal: MutationJournalPort;
  cache?: ProjectCache;
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

export async function readSourceFile(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
  path: RelPath,
) {
  try {
    const found = await projectRef(dependencies, projectId);
    if (!found.ok) return found;
    const resolved = await dependencies.workspace.resolve(found.value, path, "read-source");
    if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "source path was rejected" });
    const file = await dependencies.workspace.readFile(resolved.value);
    return file
      ? ok({ path, content: file.content, contentHash: file.contentHash })
      : err({ code: ErrorCode.NotFound, message: "source file was not found" });
  } catch {
    return storageError("source file could not be read");
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
  scenes: unknown[];
  rootTrack: unknown | null;
  previewSettings: PreviewSettings;
  previewSettingsRevision: number;
  revision: number;
  diagnostics: CompositionModel["diagnostics"];
}

export async function getStudioSnapshot(
  dependencies: ProjectReadDependencies,
  projectId: ProjectId,
): Promise<Result<StudioSnapshot, DomainError>> {
  try {
    const found = await projectRef(dependencies, projectId);
    if (!found.ok) return found;
    const [model, entry, tree, settings] = await Promise.all([
      parseProject(dependencies, found.value),
      readSourceFile(dependencies, projectId, found.value.entry),
      dependencies.workspace.readTree(found.value),
      getPreviewSettings(dependencies, projectId),
    ]);
    if (!entry.ok) return entry;
    if (!settings.ok) return settings;
    const revision = (await dependencies.journal.latestRevision(projectId)) ?? 0;
    return ok({
      project: { ...model.project, revision },
      entryFile: entry.value,
      tree,
      scenes: model.scenes,
      rootTrack: model.rootTrack,
      previewSettings: settings.value.previewSettings,
      previewSettingsRevision: settings.value.revision,
      revision,
      diagnostics: model.diagnostics,
    });
  } catch {
    return storageError("studio snapshot could not be built");
  }
}
