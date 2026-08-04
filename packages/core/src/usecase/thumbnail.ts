import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";

import type { WorkspacePort } from "../port/ports";
import type { SnapshotState } from "../service/project-state-store";
import type { WorkspaceEntry } from "./scan-workspace";

export type Thumbnail =
  | { kind: "image"; path: RelPath; stale: boolean; etag: ContentHash }
  | { kind: "placeholder"; seed: string; seedKind: "projectId" | "slug"; invalid: boolean };

export function placeholderThumbnail(entry: WorkspaceEntry): Extract<Thumbnail, { kind: "placeholder" }> {
  const identityInvalid = entry.kind === "project" && entry.state === "invalid" && entry.invalidKind === "identity";
  return {
    kind: "placeholder",
    seed: identityInvalid ? entry.slug : "projectId" in entry && entry.projectId ? entry.projectId : entry.slug,
    seedKind: identityInvalid ? "slug" : "projectId",
    invalid: entry.kind === "project" && entry.state === "invalid",
  };
}

/** Resolves a real snapshot hash when present, otherwise a stable placeholder. */
export class ThumbnailResolver {
  constructor(private readonly workspace: WorkspacePort) {}

  async resolve(
    entry: WorkspaceEntry,
    snapshots: SnapshotState | null,
    sourceRevision: number | null,
  ): Promise<Thumbnail> {
    if (entry.kind !== "project" || entry.projectId === null || !snapshots) return placeholderThumbnail(entry);
    const ref = await this.workspace.readProjectRef(entry.projectId as ProjectId);
    if (!ref) return placeholderThumbnail(entry);
    const path = snapshots.contactSheet
      ?? (snapshots.sceneIds[0] ? snapshots.snapshotPaths[snapshots.sceneIds[0]] ?? null : null);
    if (!path) return placeholderThumbnail(entry);
    const resolved = await this.workspace.resolve(ref, path, "read-asset");
    if (!resolved.ok) return placeholderThumbnail(entry);
    const etag = await this.workspace.readHash(resolved.value);
    return etag ? {
      kind: "image",
      path,
      stale: sourceRevision === null || snapshots.computedAtSourceRevision !== sourceRevision,
      etag,
    } : placeholderThumbnail(entry);
  }
}

