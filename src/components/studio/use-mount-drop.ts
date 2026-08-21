"use client";

import * as React from "react";

import { fetchApi, type ApiPath } from "@/lib/api/services";
import { startAssetUpload } from "@/lib/studio/asset-manager";
import { createUlid } from "@/lib/studio/ids";
import {
  dropFileOntoTimeline,
  mountExistingAsset,
  retryPendingMount,
  type DropTransport,
  type MountOutcome,
} from "@/lib/studio/mount-drop";
import { type ProjectChanged } from "@/lib/studio/preview-reload";
import { useStudioSession } from "./studio-session-context";

export interface PendingMountItem {
  operationId: string;
  assetPath: string;
  atSeconds: number;
  trackIndex: number;
  lastFailure: { code: string; message: string } | null;
  updatedAt: string;
}

/**
 * The browser side of a timeline drop.
 *
 * Every decision that matters — where the clip lands, how long it is, what the
 * file ends up called — belongs to the server; this only reports what the one
 * state machine in `mount-drop.ts` says and keeps a single progress value for
 * both of its steps.
 */
export function useMountDrop(input: {
  projectId: string;
  revision: number;
  entryContentHash: string | null;
  onProjectChanged: ProjectChanged;
}) {
  const { projectId, revision, entryContentHash, onProjectChanged } = input;
  const studio = useStudioSession();
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PendingMountItem[]>([]);
  const cancelRef = React.useRef<(() => void) | null>(null);

  const transport = React.useCallback((file: File | null, placement: { atSeconds: number; trackIndex: number }): DropTransport => ({
    async upload(operationId) {
      if (!file) throw new Error("there is no file to upload");
      const operation = startAssetUpload({
        projectId,
        file,
        expectedRevision: revision,
        requestInit: studio.request(),
        pendingMount: { operationId, ...placement },
        onProgress: setProgress,
      });
      cancelRef.current = operation.cancel;
      try { return await operation.promise; }
      finally { cancelRef.current = null; }
    },
    send(request) {
      return fetchApi(
        request.path as ApiPath,
        request.method === "GET"
          ? {}
          : studio.request({
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request.body ?? {}),
            }),
      );
    },
  }), [projectId, revision, studio]);

  const refreshPending = React.useCallback(async () => {
    const response = await fetchApi(`/api/v1/projects/${encodeURIComponent(projectId)}/pending-mounts` as ApiPath);
    const payload = await response.json().catch(() => null) as { items?: PendingMountItem[] } | null;
    setPending(response.ok && payload?.items ? payload.items : []);
  }, [projectId]);

  const settle = React.useCallback(async (outcome: MountOutcome) => {
    if (outcome.kind === "mounted") {
      setError(null);
      onProjectChanged(outcome.changeSeq);
    } else {
      setError(outcome.kind === "uploaded_unmounted"
        // The file is safe: say so, because the obvious reading of a failed drop
        // is that the upload was lost too.
        ? `${outcome.message} The file is in Media${outcome.terminal ? "" : " — you can try mounting it again"}.`
        : outcome.message);
    }
    setProgress(null);
    await refreshPending();
    return outcome;
  }, [onProjectChanged, refreshPending]);

  /** A file from outside: one operation id covers both the upload and the mount. */
  const dropFile = React.useCallback(async (
    file: File,
    placement: { atSeconds: number; trackIndex: number; onOverflow?: "shrink" | "extend-root" },
  ) => {
    if (!entryContentHash) return null;
    setError(null);
    setProgress(0);
    return await settle(await dropFileOntoTimeline({
      projectId,
      operationId: createUlid(),
      atSeconds: placement.atSeconds,
      trackIndex: placement.trackIndex,
      expectedContentHash: entryContentHash,
      onOverflow: placement.onOverflow ?? "extend-root",
      transport: transport(file, placement),
      onProgress: setProgress,
    }));
  }, [entryContentHash, projectId, settle, transport]);

  /** An asset already in the project: one mutation and no operation id at all. */
  const dropAsset = React.useCallback(async (
    asset: { path: string; contentHash: string },
    placement: { atSeconds: number; trackIndex: number; onOverflow?: "shrink" | "extend-root" },
  ) => {
    if (!entryContentHash) return null;
    setError(null);
    return await settle(await mountExistingAsset({
      projectId,
      assetPath: asset.path,
      assetContentHash: asset.contentHash,
      atSeconds: placement.atSeconds,
      trackIndex: placement.trackIndex,
      expectedContentHash: entryContentHash,
      onOverflow: placement.onOverflow ?? "extend-root",
      transport: transport(null, placement),
    }));
  }, [entryContentHash, projectId, settle, transport]);

  /** Same as `dropAsset`, but the hash is read from the server rather than the drag. */
  const dropAssetPath = React.useCallback(async (
    path: string,
    placement: { atSeconds: number; trackIndex: number; onOverflow?: "shrink" | "extend-root" },
  ) => {
    const response = await fetchApi(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}` as ApiPath,
    );
    const payload = await response.json().catch(() => null) as {
      entry?: { kind: string; expectedContentHash?: string };
    } | null;
    const contentHash = payload?.entry?.kind === "file" ? payload.entry.expectedContentHash : undefined;
    if (!contentHash) {
      setError("that asset could not be read, so it was not mounted");
      return null;
    }
    return await dropAsset({ path, contentHash }, placement);
  }, [dropAsset, projectId]);

  const retryMount = React.useCallback(async (operationId: string) => {
    if (!entryContentHash) return null;
    setError(null);
    return await settle(await retryPendingMount({
      projectId,
      operationId,
      expectedContentHash: entryContentHash,
      onOverflow: "extend-root",
      transport: transport(null, { atSeconds: 0, trackIndex: 0 }),
    }));
  }, [entryContentHash, projectId, settle, transport]);

  const abandonMount = React.useCallback(async (operationId: string) => {
    await fetchApi(
      `/api/v1/projects/${encodeURIComponent(projectId)}/pending-mounts/${encodeURIComponent(operationId)}` as ApiPath,
      studio.request({ method: "DELETE" }),
    );
    await refreshPending();
  }, [projectId, refreshPending, studio]);

  return {
    progress,
    error,
    pending,
    refreshPending,
    dropFile,
    dropAsset,
    dropAssetPath,
    retryMount,
    abandonMount,
    cancelUpload: () => cancelRef.current?.(),
  };
}
