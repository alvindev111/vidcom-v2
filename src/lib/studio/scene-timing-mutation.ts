import type { TimingCommit } from "./editor-interaction";

export interface TimingRequest {
  path: `/api/${string}`;
  body: {
    timing: TimingCommit["timing"];
    ripple: boolean;
    expectedContentHash: string;
    extendRoot?: true;
  };
}

export type SceneTimingMutationResult =
  | { kind: "no-change" }
  | { kind: "saved"; file: { path: string; contentHash: string }; changeSeq: number | null }
  | { kind: "source-conflict"; message: string }
  | { kind: "root-overflow"; message: string; canExtendRoot: true }
  | { kind: "runtime-overflow"; message: string; canExtendRoot: false }
  | { kind: "failed"; message: string };

interface ErrorPayload {
  error?: {
    message?: string;
    details?: { limitKind?: unknown; extendRootAllowed?: unknown };
  };
}

export async function saveSceneTiming(input: {
  projectId: string;
  expectedContentHash: string;
  commit: TimingCommit | null;
  extendRoot?: boolean;
  send(request: TimingRequest): Promise<Response>;
}): Promise<SceneTimingMutationResult> {
  if (!input.commit) return { kind: "no-change" };
  const request: TimingRequest = {
    path: `/api/v1/projects/${encodeURIComponent(input.projectId)}/scenes/${encodeURIComponent(input.commit.sceneId)}`,
    body: {
      timing: input.commit.timing,
      ripple: input.commit.ripple,
      expectedContentHash: input.expectedContentHash,
      ...(input.extendRoot ? { extendRoot: true as const } : {}),
    },
  };
  const response = await input.send(request);
  const payload = await response.json().catch(() => null) as (ErrorPayload & {
    file?: { path?: unknown; contentHash?: unknown };
    changeSeq?: unknown;
  }) | null;
  if (response.ok && typeof payload?.file?.path === "string" && typeof payload.file.contentHash === "string") {
    return {
      kind: "saved",
      file: { path: payload.file.path, contentHash: payload.file.contentHash },
      changeSeq: typeof payload.changeSeq === "number" ? payload.changeSeq : null,
    };
  }
  const message = payload?.error?.message ?? `Timing save failed (${response.status}).`;
  if (response.status === 409) return { kind: "source-conflict", message };
  const details = payload?.error?.details;
  if (response.status === 422 && details?.limitKind === "root" && details.extendRootAllowed === true) {
    return { kind: "root-overflow", message, canExtendRoot: true };
  }
  if (response.status === 422 && details?.limitKind === "runtime") {
    return { kind: "runtime-overflow", message, canExtendRoot: false };
  }
  return { kind: "failed", message };
}
