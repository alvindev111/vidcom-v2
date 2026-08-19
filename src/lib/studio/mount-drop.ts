/**
 * The one state machine behind dropping something onto the timeline (R11.2, R11.3b).
 *
 * A file from outside is two server steps — upload, then mount — but one thing to
 * the person doing it: one progress bar, one result. Keeping the machine here
 * rather than in a component is what lets both steps be tested without a browser,
 * and what keeps the components from inventing timings or file names of their own.
 */

export interface MountRequest {
  path: `/api/${string}`;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}

export interface DropTransport {
  /** Sends the bytes under `operationId`; rejects with `ambiguous` when the outcome is unknown. */
  upload(operationId: string): Promise<{ path: string; changeSeq: number | null }>;
  send(request: MountRequest): Promise<Response>;
}

export type MountOutcome =
  | {
      kind: "mounted";
      sceneId: string;
      durationSeconds: number;
      revision: number;
      changeSeq: number | null;
      replayed: boolean;
    }
  | {
      /** The file is in Media; only the mount is outstanding. */
      kind: "uploaded_unmounted";
      operationId: string;
      assetPath: string | null;
      message: string;
      /** The operation is over: retrying it can never succeed. */
      terminal: boolean;
    }
  | { kind: "failed"; message: string };

interface MountPolicy {
  projectId: string;
  expectedContentHash: string;
  onOverflow: "shrink" | "extend-root";
}

function mountPath(projectId: string): `/api/${string}` {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/assets/mount`;
}

function pendingPath(projectId: string, operationId: string): `/api/${string}` {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/pending-mounts/${encodeURIComponent(operationId)}`;
}

async function mount(
  transport: DropTransport,
  projectId: string,
  body: Record<string, unknown>,
): Promise<MountOutcome | { kind: "refused"; message: string; terminal: boolean }> {
  let response: Response;
  try { response = await transport.send({ path: mountPath(projectId), method: "POST", body }); }
  catch (cause) {
    return { kind: "refused", message: messageOf(cause, "the mount could not be sent"), terminal: false };
  }
  const payload = await response.json().catch(() => null) as {
    sceneId?: string; durationSeconds?: number; revision?: number; changeSeq?: number | null;
    replayed?: boolean; error?: { message?: string };
  } | null;
  if (response.ok && payload?.sceneId && typeof payload.durationSeconds === "number") {
    return {
      kind: "mounted",
      sceneId: payload.sceneId,
      durationSeconds: payload.durationSeconds,
      revision: payload.revision ?? 0,
      changeSeq: payload.changeSeq ?? null,
      replayed: payload.replayed ?? false,
    };
  }
  return {
    kind: "refused",
    message: payload?.error?.message ?? `The mount failed (${response.status}).`,
    // 404 means the operation is gone for good. Starting a new one would upload the
    // same bytes again under a fresh id, which is exactly the duplicate the
    // operation id exists to prevent.
    terminal: response.status === 404,
  };
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Mounts a file that is already in the project: one request, no operation id. */
export async function mountExistingAsset(input: MountPolicy & {
  assetPath: string;
  assetContentHash: string;
  atSeconds: number;
  trackIndex: number;
  transport: DropTransport;
}): Promise<MountOutcome> {
  const result = await mount(input.transport, input.projectId, {
    assetPath: input.assetPath,
    assetContentHash: input.assetContentHash,
    atSeconds: input.atSeconds,
    trackIndex: input.trackIndex,
    expectedContentHash: input.expectedContentHash,
    onOverflow: input.onOverflow,
  });
  return result.kind === "refused" ? { kind: "failed", message: result.message } : result;
}

/** Mounts an upload that is waiting in Media; the record owns where it goes. */
export async function retryPendingMount(input: MountPolicy & {
  operationId: string;
  transport: DropTransport;
}): Promise<MountOutcome> {
  const result = await mount(input.transport, input.projectId, {
    operationId: input.operationId,
    expectedContentHash: input.expectedContentHash,
    onOverflow: input.onOverflow,
  });
  return result.kind === "refused"
    ? {
        kind: "uploaded_unmounted",
        operationId: input.operationId,
        assetPath: null,
        message: result.message,
        terminal: result.terminal,
      }
    : result;
}

/** Reads one pending operation back; `null` means the server has no row for it. */
async function readPending(
  transport: DropTransport,
  projectId: string,
  operationId: string,
): Promise<{ assetPath: string } | null> {
  let response: Response;
  try { response = await transport.send({ path: pendingPath(projectId, operationId), method: "GET" }); }
  catch { return null; }
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null) as { assetPath?: string } | null;
  return payload?.assetPath ? { assetPath: payload.assetPath } : null;
}

/**
 * Runs a dropped file all the way to a mounted scene.
 *
 * Upload owns 0–90 % of the single progress bar and mount the rest, so the person
 * sees one bar rather than two that each restart. A failed or cancelled upload
 * ends the drop without ever calling mount: there is nothing on the server to
 * mount, and a mount call would only produce a second, confusing error.
 */
export async function dropFileOntoTimeline(input: MountPolicy & {
  operationId: string;
  atSeconds: number;
  trackIndex: number;
  transport: DropTransport;
  onProgress(value: number): void;
}): Promise<MountOutcome> {
  input.onProgress(0);
  let uploaded: { path: string; changeSeq: number | null };
  try { uploaded = await input.transport.upload(input.operationId); }
  catch (cause) {
    // An ambiguous transport failure is the one case where the bytes may already
    // be on disk. Asking first is what keeps a retry from uploading them twice.
    if (!(cause as { ambiguous?: boolean }).ambiguous) {
      return { kind: "failed", message: messageOf(cause, "the upload failed") };
    }
    const existing = await readPending(input.transport, input.projectId, input.operationId);
    if (existing) {
      uploaded = { path: existing.assetPath, changeSeq: null };
    } else {
      // No row: resend under the same operation id. A new id here would be a
      // second upload of the same drop.
      try { uploaded = await input.transport.upload(input.operationId); }
      catch (retryCause) {
        return { kind: "failed", message: messageOf(retryCause, "the upload failed") };
      }
    }
  }
  input.onProgress(90);
  const result = await mount(input.transport, input.projectId, {
    operationId: input.operationId,
    expectedContentHash: input.expectedContentHash,
    onOverflow: input.onOverflow,
  });
  if (result.kind === "refused") {
    return {
      kind: "uploaded_unmounted",
      operationId: input.operationId,
      assetPath: uploaded.path,
      message: result.message,
      terminal: result.terminal,
    };
  }
  input.onProgress(100);
  return result;
}

/**
 * Where a pointer over the timeline lands, in seconds on the given track.
 *
 * The drop point is a pointer position, so it belongs to the browser — but it is
 * the only thing the browser decides. Everything the clip becomes after that
 * (its duration, its file name, how the root grows) is the server's.
 */
export function dropPlacement(input: {
  pointerX: number;
  surfaceLeft: number;
  gutterPx: number;
  pixelsPerSecond: number;
  duration: number;
  trackIndex: number;
}): { atSeconds: number; trackIndex: number } {
  const offset = input.pointerX - input.surfaceLeft - input.gutterPx;
  const seconds = input.pixelsPerSecond > 0 ? offset / input.pixelsPerSecond : 0;
  const clamped = Math.min(Math.max(seconds, 0), Math.max(input.duration, 0));
  return {
    atSeconds: Math.round(clamped * 1_000) / 1_000,
    trackIndex: Math.max(0, Math.trunc(input.trackIndex)),
  };
}
