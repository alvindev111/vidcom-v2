export interface SceneOrderRequest {
  path: `/api/${string}`;
  method: "PATCH" | "POST";
  body: Record<string, unknown>;
}

type Send = (request: SceneOrderRequest) => Promise<Response>;

export type SceneOrderMutationResult =
  | { kind: "saved"; changed: boolean; file: { path: string; contentHash: string }; changeSeq: number | null }
  | { kind: "source-conflict"; message: string }
  | { kind: "root-overflow"; message: string; canExtendRoot: true }
  | { kind: "runtime-overflow" | "failed"; message: string };

async function mutation(request: SceneOrderRequest, send: Send): Promise<SceneOrderMutationResult> {
  const response = await send(request);
  const payload = await response.json().catch(() => null) as {
    changed?: boolean;
    file?: { path?: string; contentHash?: string };
    changeSeq?: number | null;
    error?: { message?: string; details?: { limitKind?: string; extendRootAllowed?: boolean } };
  } | null;
  if (response.ok && payload?.file?.path && payload.file.contentHash) {
    return {
      kind: "saved",
      changed: payload.changed ?? true,
      file: { path: payload.file.path, contentHash: payload.file.contentHash },
      changeSeq: payload.changeSeq ?? null,
    };
  }
  const message = payload?.error?.message ?? `Scene mutation failed (${response.status}).`;
  if (response.status === 409) return { kind: "source-conflict", message };
  if (response.status === 422 && payload?.error?.details?.limitKind === "root"
    && payload.error.details.extendRootAllowed === true) {
    return { kind: "root-overflow", message, canExtendRoot: true };
  }
  if (response.status === 422 && payload?.error?.details?.limitKind === "runtime") {
    return { kind: "runtime-overflow", message };
  }
  return { kind: "failed", message };
}

export function saveSceneReorder(input: {
  projectId: string;
  expectedContentHash: string;
  sceneId: string;
  toIndex: number;
  toTrackIndex?: number;
  extendRoot?: boolean;
  send: Send;
}): Promise<SceneOrderMutationResult> {
  return mutation({
    path: `/api/v1/projects/${input.projectId}/scenes/order`,
    method: "PATCH",
    body: {
      sceneId: input.sceneId,
      toIndex: input.toIndex,
      ...(input.toTrackIndex === undefined ? {} : { toTrackIndex: input.toTrackIndex }),
      ...(input.extendRoot ? { extendRoot: true } : {}),
      expectedContentHash: input.expectedContentHash,
    },
  }, input.send);
}

export function saveSceneGroupMove(input: {
  projectId: string;
  expectedContentHash: string;
  sceneIds: string[];
  deltaSeconds: number;
  extendRoot?: boolean;
  send: Send;
}): Promise<SceneOrderMutationResult> {
  return mutation({
    path: `/api/v1/projects/${input.projectId}/scenes/move`,
    method: "POST",
    body: {
      sceneIds: input.sceneIds,
      deltaSeconds: input.deltaSeconds,
      ...(input.extendRoot ? { extendRoot: true } : {}),
      expectedContentHash: input.expectedContentHash,
    },
  }, input.send);
}

export type PreparedSceneDeletion =
  | { kind: "prepared"; grantId: string; sceneIds: string[]; plan: unknown }
  | { kind: "failed"; message: string };

export async function prepareSceneSelectionDeletion(input: {
  projectId: string;
  sceneIds: string[];
  expectedRevision: number;
  send: Send;
}): Promise<PreparedSceneDeletion> {
  const sceneIds = [...input.sceneIds].sort((left, right) => left.localeCompare(right));
  const request: SceneOrderRequest = {
    path: `/api/v1/projects/${input.projectId}/scenes/deletions`,
    method: "POST",
    body: { sceneIds, expectedRevision: input.expectedRevision },
  };
  const response = await input.send(request);
  const payload = await response.json().catch(() => null) as {
    grantId?: string;
    plan?: { sceneIds?: string[] };
    error?: { message?: string };
  } | null;
  return response.ok && payload?.grantId && Array.isArray(payload.plan?.sceneIds)
    ? { kind: "prepared", grantId: payload.grantId, sceneIds: payload.plan.sceneIds, plan: payload.plan }
    : { kind: "failed", message: payload?.error?.message ?? `Deletion planning failed (${response.status}).` };
}

export async function deleteSceneSelection(input: {
  projectId: string;
  sceneIds: string[];
  expectedRevision: number;
  grantId: string;
  send: Send;
}): Promise<{ kind: "deleted"; changeSeq: number | null } | { kind: "failed"; message: string }> {
  const request: SceneOrderRequest = {
    path: `/api/v1/projects/${input.projectId}/scenes/deletions/${input.grantId}`,
    method: "POST",
    body: { sceneIds: input.sceneIds, expectedRevision: input.expectedRevision },
  };
  const response = await input.send(request);
  const payload = await response.json().catch(() => null) as {
    changeSeq?: number | null;
    error?: { message?: string };
  } | null;
  return response.ok
    ? { kind: "deleted", changeSeq: payload?.changeSeq ?? null }
    : { kind: "failed", message: payload?.error?.message ?? `Scene deletion failed (${response.status}).` };
}
