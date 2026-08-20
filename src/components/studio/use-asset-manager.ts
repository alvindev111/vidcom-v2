"use client";

import * as React from "react";

import { fetchApi } from "@/lib/api/services";
import { entryMutationRequest, startAssetUpload } from "@/lib/studio/asset-manager";
import { mutationChangeSeq, type ProjectChanged } from "@/lib/studio/preview-reload";
import { useStudioSession } from "./studio-session-context";

type EntryExpectation =
  | { path: string; kind: "file"; expectedContentHash: string }
  | { path: string; kind: "folder"; expectedTreeDigest: string };

export function useAssetManager(
  projectId: string,
  revision: number,
  entryContentHash: string | null,
  onProjectChanged: ProjectChanged,
) {
  const studio = useStudioSession();
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [metadata, setMetadata] = React.useState<Record<string, unknown> | null>(null);
  const cancelRef = React.useRef<(() => void) | null>(null);

  const send = React.useCallback(async (request: ReturnType<typeof entryMutationRequest>) => {
    setError(null);
    const response = await fetchApi(request.path, studio.request(request.init));
    const payload = await response.json().catch(() => null) as {
      changeSeq?: number | null; error?: { message?: string }; grantId?: string;
    } | null;
    if (!response.ok) throw new Error(payload?.error?.message ?? `request failed (${response.status})`);
    return payload;
  }, [studio]);

  const expectation = React.useCallback(async (path: string): Promise<EntryExpectation> => {
    const response = await fetchApi(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`,
    );
    const payload = await response.json().catch(() => null) as {
      entry?: EntryExpectation; error?: { message?: string };
    } | null;
    if (!response.ok || !payload?.entry) throw new Error(payload?.error?.message ?? "entry could not be inspected");
    return payload.entry;
  }, [projectId]);

  const create = React.useCallback(async (path: string, kind: "file" | "folder") => {
    try {
      const payload = await send(entryMutationRequest(projectId, "create", { path, kind, expectedRevision: revision }));
      onProjectChanged(mutationChangeSeq(payload));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "entry creation failed"); }
  }, [onProjectChanged, projectId, revision, send]);

  const rename = React.useCallback(async (path: string, to: string) => {
    try {
      const current = await expectation(path);
      const expected = current.kind === "file"
        ? { expectedContentHash: current.expectedContentHash }
        : { expectedTreeDigest: current.expectedTreeDigest };
      const payload = await send(entryMutationRequest(projectId, "rename", {
        from: path, to, expectedRevision: revision, ...expected,
      }));
      onProjectChanged(mutationChangeSeq(payload));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "entry rename failed"); }
  }, [expectation, onProjectChanged, projectId, revision, send]);

  const remove = React.useCallback(async (path: string) => {
    try {
      const intent = { path, recursive: true, expectedRevision: revision };
      const prepared = await send(entryMutationRequest(projectId, "prepare-delete", intent));
      if (!prepared?.grantId) throw new Error("deletion approval was not created");
      const payload = await send(entryMutationRequest(projectId, "delete", intent, prepared.grantId));
      onProjectChanged(mutationChangeSeq(payload));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "entry deletion failed"); }
  }, [onProjectChanged, projectId, revision, send]);

  const upload = React.useCallback(async (file: File) => {
    setError(null);
    setProgress(0);
    const operation = startAssetUpload({
      projectId, file, expectedRevision: revision, requestInit: studio.request(), onProgress: setProgress,
    });
    cancelRef.current = operation.cancel;
    try {
      const uploaded = await operation.promise;
      onProjectChanged(uploaded.changeSeq);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "upload failed"); }
    finally { cancelRef.current = null; }
  }, [onProjectChanged, projectId, revision, studio]);

  const inspect = React.useCallback(async (path: string) => {
    setMetadata(null);
    if (!path.startsWith("assets/")) return;
    const response = await fetchApi(
      `/api/v1/projects/${encodeURIComponent(projectId)}/assets/${path.split("/").map(encodeURIComponent).join("/")}/metadata`,
    );
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok && payload) setMetadata(payload);
    else setMetadata({ status: "unknown", reason: "metadata could not be loaded" });
  }, [projectId]);

  const applyFont = React.useCallback(async (path: string) => {
    if (!entryContentHash) return;
    try {
      const current = await expectation(path);
      if (current.kind !== "file") throw new Error("font is not a file");
      const response = await fetchApi(`/api/v1/projects/${encodeURIComponent(projectId)}/fonts/apply`, studio.request({
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          fontPath: path, fontContentHash: current.expectedContentHash,
          scope: { kind: "project" }, expectedContentHash: entryContentHash,
        }),
      }));
      const payload = await response.json().catch(() => null) as { changeSeq?: number | null; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? "font application failed");
      onProjectChanged(mutationChangeSeq(payload));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "font application failed"); }
  }, [entryContentHash, expectation, onProjectChanged, projectId, studio]);

  return {
    progress, error, metadata, create, rename, remove, upload, inspect, applyFont,
    cancelUpload: () => cancelRef.current?.(),
  };
}
