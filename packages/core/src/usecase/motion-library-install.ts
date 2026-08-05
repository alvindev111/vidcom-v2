import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import {
  findMotionLibrary,
  MOTION_LIBRARY_IDS,
  motionLibraryImportSpecifier,
  motionLibraryScriptTag,
  type MotionLibrary,
  type MotionLibraryId,
  type MotionLibraryLoader,
} from "../domain/motion-libraries";
import { err, ok, type Result } from "../error/result";
import type { MotionLibraryFilesPort, WorkspacePort } from "../port/ports";
import type { CompositeRequest, WriteEnvelope, WriteInvocation } from "../port/types";

export interface MotionLibraryInstallDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readFile">;
  motionLibraries: MotionLibraryFilesPort;
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
}

export interface MotionLibraryInstallOutput {
  status: "installed" | "already_installed";
  library: {
    id: MotionLibraryId;
    version: string;
    loader: MotionLibraryLoader;
    globalName: string | null;
    entry: RelPath;
    /** Paste-ready tag for the composition `<head>`. */
    scriptTag: string;
    /** Specifier to import inside the author's own module script; null for a global library. */
    importSpecifier: string | null;
  };
  files: Array<{ path: RelPath; contentHash: ContentHash | null }>;
  revision: number | null;
}

interface VendoredFile {
  path: RelPath;
  content: string;
  currentHash: ContentHash | null;
  changed: boolean;
}

function describe(library: MotionLibrary): MotionLibraryInstallOutput["library"] {
  return {
    id: library.id,
    version: library.version,
    loader: library.loader,
    globalName: library.globalName,
    entry: library.entry,
    scriptTag: motionLibraryScriptTag(library),
    importSpecifier: motionLibraryImportSpecifier(library),
  };
}

/**
 * Vendors one pinned motion library into `assets/vendor/` so the project keeps
 * rendering without network access. Re-running is a no-op once every file
 * already matches, and a multi-file library lands as one atomic mutation — a
 * half-installed Three.js would fail at its `./three.core.min.js` import.
 */
export async function installMotionLibrary(
  dependencies: MotionLibraryInstallDependencies,
  input: { projectId: ProjectId; libraryId: string },
  actor: Actor,
  invocation: WriteInvocation = { toolAudit: null },
): Promise<Result<MotionLibraryInstallOutput, DomainError>> {
  const library = findMotionLibrary(input.libraryId);
  if (!library) {
    return err({
      code: ErrorCode.SchemaInvalid,
      message: `libraryId must be one of ${MOTION_LIBRARY_IDS.join(", ")}`,
      field: "libraryId",
    });
  }
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });

  const sources = await dependencies.motionLibraries.read(library);
  if (!sources.ok) return sources;

  const vendored: VendoredFile[] = [];
  for (const source of sources.value) {
    const resolved = await dependencies.workspace.resolve(ref, source.projectPath, "read-asset");
    if (!resolved.ok) {
      return err({ code: ErrorCode.PathOutsideProject, message: "vendor path was rejected" });
    }
    const current = await dependencies.workspace.readFile(resolved.value);
    vendored.push({
      path: source.projectPath,
      content: source.content,
      currentHash: current?.contentHash ?? null,
      changed: current?.content !== source.content,
    });
  }

  const steps: CompositeRequest["steps"] = vendored
    .filter(({ changed }) => changed)
    .map(({ path, content, currentHash }) => ({
      kind: "write",
      path,
      content,
      expectedContentHash: currentHash,
    }));
  if (steps.length === 0) {
    return ok({
      status: "already_installed",
      library: describe(library),
      files: vendored.map(({ path, currentHash }) => ({ path, contentHash: currentHash })),
      revision: null,
    });
  }

  const written = await dependencies.authority.mutateSource({
    ref,
    steps,
    toolAudit: invocation.toolAudit,
    backup: false,
  }, actor);
  if (!written.ok) return written;
  return ok({
    status: "installed",
    library: describe(library),
    files: vendored.map(({ path, currentHash }) => ({
      path,
      contentHash: written.value.fileHashes[path] ?? currentHash,
    })),
    revision: written.value.projectRevision,
  });
}
