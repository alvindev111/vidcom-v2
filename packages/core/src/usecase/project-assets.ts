import {
  ErrorCode,
  MAX_LISTED_PROJECT_ASSETS,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { checkPathPurpose, checkPathSyntax } from "../domain/path-policy";
import { WorkspaceResourceLimitError, type FileNode } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { AssetProbeMetadata, JobStorePort, MediaProbePort, WorkspacePort } from "../port/ports";
import type { JobId } from "../port/types";
import { getPreviewSettings, type ProjectReadDependencies } from "./project-reads";

/** Asset classes an agent can act on without reading the bytes. */
export type ProjectAssetKind = "audio" | "image" | "video" | "font" | "other";

export interface ProjectAsset {
  path: RelPath;
  kind: ProjectAssetKind;
  byteSize: number;
  modifiedAt: string;
  referencedByPreviewSettings: boolean;
}

const KINDS: ReadonlyArray<readonly [ProjectAssetKind, ReadonlySet<string>]> = [
  ["audio", new Set(["mp3", "wav", "ogg", "m4a"])],
  ["image", new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "svg"])],
  ["video", new Set(["mp4", "webm", "mov"])],
  ["font", new Set(["woff", "woff2", "ttf", "otf"])],
];

/** Extensions the BGM player can actually decode; a PNG named as a track is a silent preview. */
export const BGM_EXTENSIONS: ReadonlySet<string> = new Set(["mp3", "wav", "ogg", "m4a"]);

export function assetExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/** Probes one contained project asset; Core owns the font/media dispatch decision. */
export async function getProjectAssetMetadata(
  dependencies: {
    workspace: Pick<WorkspacePort, "readProjectRef">;
    probe: MediaProbePort;
  },
  input: { projectId: ProjectId; path: RelPath },
): Promise<Result<AssetProbeMetadata, DomainError>> {
  if (checkPathSyntax(input.path) || checkPathPurpose(input.path, "read-asset")) {
    return err({ code: ErrorCode.AssetNotAllowed, message: "asset path is not allowed", field: "path" });
  }
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  return KINDS.find(([kind, extensions]) => kind === "font" && extensions.has(assetExtension(input.path)))
    ? dependencies.probe.probeFont(ref, input.path)
    : dependencies.probe.probeMedia(ref, input.path);
}

function assetKind(path: string): ProjectAssetKind {
  const extension = assetExtension(path);
  return KINDS.find(([, extensions]) => extensions.has(extension))?.[0] ?? "other";
}

function flatten(nodes: readonly FileNode[]): RelPath[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node.path] : flatten(node.children ?? []));
}

/**
 * Lists the media already sitting in the project directory.
 *
 * This is how a headless agent learns about a file a person dropped in: nothing
 * announces it, and no upload happened, so the only honest answer is to read
 * what the directory now contains — through the same `read-asset` allowlist the
 * preview and render paths use, never a general directory walk.
 */
export async function listProjectAssets(
  dependencies: ProjectReadDependencies,
  input: { projectId: ProjectId; directory?: string },
): Promise<Result<{ assets: ProjectAsset[]; truncated: boolean }, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  if (input.directory !== undefined && checkPathSyntax(input.directory)) {
    return err({ code: ErrorCode.PathInvalid, message: "the directory is invalid", field: "directory" });
  }
  const prefix = input.directory === undefined
    ? null
    : input.directory.endsWith("/") ? input.directory : `${input.directory}/`;
  const settings = await getPreviewSettings(dependencies, input.projectId);
  const track = settings.ok ? settings.value.previewSettings.bgm.track?.path ?? null : null;

  let candidates: RelPath[];
  try {
    candidates = flatten(await dependencies.workspace.readTree(ref));
  } catch (error) {
    return error instanceof WorkspaceResourceLimitError
      ? err({
          code: ErrorCode.ResourceLimitExceeded,
          message: "the project asset tree crossed a resource limit",
          details: { reason: error.reason, limit: error.limit, actual: error.actual },
        })
      : err({ code: ErrorCode.StorageUnavailable, message: "the project tree could not be read" });
  }
  const allowed = candidates
    .filter((path) => !checkPathSyntax(path) && !checkPathPurpose(path, "read-asset"))
    .filter((path) => prefix === null || path.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
  const page = allowed.slice(0, MAX_LISTED_PROJECT_ASSETS);

  const assets: ProjectAsset[] = [];
  for (const path of page) {
    const resolved = await dependencies.workspace.resolve(ref, path, "read-asset");
    if (!resolved.ok) continue;
    const stat = await dependencies.workspace.stat(resolved.value);
    if (!stat) continue;
    assets.push({
      path,
      kind: assetKind(path),
      byteSize: stat.size,
      modifiedAt: stat.modifiedAt.toISOString(),
      referencedByPreviewSettings: track === path,
    });
  }
  return ok({ assets, truncated: allowed.length > page.length });
}

/** Confirms a BGM track exists as a decodable audio asset before it lands in preview settings. */
export async function assertBgmTrackReadable(
  dependencies: ProjectReadDependencies,
  input: { projectId: ProjectId; path: string },
): Promise<Result<null, DomainError>> {
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  if (checkPathSyntax(input.path) || checkPathPurpose(input.path, "read-asset")) {
    return err({
      code: ErrorCode.AssetNotAllowed,
      message: "the BGM track path is not an allowed project asset",
      field: "patch",
    });
  }
  if (!BGM_EXTENSIONS.has(assetExtension(input.path))) {
    return err({
      code: ErrorCode.UnsupportedMedia,
      message: `the BGM track must be one of ${[...BGM_EXTENSIONS].join(", ")}`,
      field: "patch",
    });
  }
  const resolved = await dependencies.workspace.resolve(ref, input.path as RelPath, "read-asset");
  if (!resolved.ok) return err({ code: ErrorCode.AssetNotAllowed, message: "the BGM track path was rejected" });
  return await dependencies.workspace.exists(resolved.value)
    ? ok(null)
    : err({
        code: ErrorCode.NoFile,
        message: "the BGM track does not exist in the project; list_project_assets shows what does",
        field: "patch",
      });
}

export interface RenderOutput {
  jobId: string;
  projectId: ProjectId;
  path: RelPath;
  absolutePath: string;
  byteSize: number;
  contentHash: ContentHash;
  mediaType: string;
  outcome: "succeeded" | "partial";
}

/**
 * Locates a finished render on disk instead of returning its bytes.
 *
 * The agent host runs on the same machine as the workspace, so a path it can
 * open beats megabytes of base64 through the tool channel.
 */
export async function readRenderOutput(
  dependencies: ProjectReadDependencies & {
    jobs: Pick<JobStorePort, "get">;
    mimeFromPath(path: string): string | null;
  },
  jobId: string,
): Promise<Result<RenderOutput, DomainError>> {
  const job = await dependencies.jobs.get(jobId as JobId);
  if (!job) return err({ code: ErrorCode.NotFound, message: "job was not found" });
  if (job.type !== "render" || job.projectId === null) {
    return err({ code: ErrorCode.NotFound, message: "the job did not produce a render artifact" });
  }
  if (job.status !== "succeeded" && job.status !== "partial") {
    return err({
      code: ErrorCode.PreconditionRequired,
      message: `the render job is ${job.status}; poll get_job_status until it succeeds`,
    });
  }
  const artifactPath = (job.result as { artifactPath?: unknown } | null)?.artifactPath;
  if (typeof artifactPath !== "string") {
    return err({ code: ErrorCode.NotFound, message: "the render job recorded no artifact path" });
  }
  const ref = await dependencies.workspace.readProjectRef(job.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const resolved = await dependencies.workspace.resolve(ref, artifactPath, "read-asset");
  if (!resolved.ok) return err({ code: ErrorCode.AssetNotAllowed, message: "the artifact path was rejected" });
  const [stat, contentHash] = await Promise.all([
    dependencies.workspace.stat(resolved.value),
    dependencies.workspace.readHash(resolved.value),
  ]);
  if (!stat || !contentHash) {
    return err({ code: ErrorCode.NotFound, message: "the render artifact is no longer on disk" });
  }
  return ok({
    jobId: job.id,
    projectId: job.projectId,
    path: artifactPath as RelPath,
    absolutePath: `${ref.root}/${artifactPath}`,
    byteSize: stat.size,
    contentHash,
    mediaType: dependencies.mimeFromPath(artifactPath) ?? "video/mp4",
    outcome: job.status,
  });
}
