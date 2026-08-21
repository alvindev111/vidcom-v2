// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  dropPlacement,
  dropFileOntoTimeline,
  mountExistingAsset,
  retryPendingMount,
  type DropTransport,
} from "@/lib/studio/mount-drop";

const projectId = "project_drop";
const OPERATION = "01K1ABCDEFGHJKMNPQRSTVWXYZ";
const ENTRY_HASH = `sha256:${"b".repeat(64)}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function transport(options: {
  upload?: () => Promise<{ path: string; changeSeq: number | null }>;
  mount?: (body: Record<string, unknown>) => Response;
  pending?: Response;
} = {}) {
  const calls: Array<{ kind: "upload" | "mount" | "pending"; body?: Record<string, unknown> }> = [];
  const progress: number[] = [];
  const transport: DropTransport = {
    async upload(operationId) {
      calls.push({ kind: "upload", body: { operationId } });
      return await (options.upload?.() ?? Promise.resolve({ path: "assets/clip.mp4", changeSeq: 3 }));
    },
    async send(request) {
      if (request.method === "GET") {
        calls.push({ kind: "pending" });
        return options.pending ?? jsonResponse(404, { error: { code: "not_found", message: "unknown operation" } });
      }
      calls.push({ kind: "mount", body: request.body });
      return options.mount?.(request.body ?? {})
        ?? jsonResponse(201, { sceneId: "scene-2", durationSeconds: 7.5, replayed: false, revision: 4, diagnostics: [], changeSeq: 9 });
    },
  };
  return { transport, calls, progress, onProgress: (value: number) => progress.push(value) };
}

const placement = { projectId, atSeconds: 2, trackIndex: 0, expectedContentHash: ENTRY_HASH, onOverflow: "extend-root" as const };

describe("timeline drop", () => {
  it("uploads then mounts under one operation and reports one continuous progress", async () => {
    const runtime = transport();
    const outcome = await dropFileOntoTimeline({
      ...placement,
      operationId: OPERATION,
      transport: runtime.transport,
      onProgress: runtime.onProgress,
    });
    expect(outcome).toEqual({ kind: "mounted", sceneId: "scene-2", durationSeconds: 7.5, revision: 4, changeSeq: 9, replayed: false });
    expect(runtime.calls.map((call) => call.kind)).toEqual(["upload", "mount"]);
    // The mount reuses the upload's operation and sends no placement of its own.
    expect(runtime.calls[1]!.body).toEqual({
      operationId: OPERATION, expectedContentHash: ENTRY_HASH, onOverflow: "extend-root",
    });
    // One bar for both steps: it never goes backwards and it ends at 100.
    expect(runtime.progress).toEqual([...runtime.progress].sort((left, right) => left - right));
    expect(runtime.progress.at(-1)).toBe(100);
  });

  it("never mounts when the upload fails or is cancelled", async () => {
    for (const failure of [new Error("upload cancelled"), new Error("upload failed (413)")]) {
      const runtime = transport({ upload: () => Promise.reject(failure) });
      const outcome = await dropFileOntoTimeline({
        ...placement,
        operationId: OPERATION,
        transport: runtime.transport,
        onProgress: runtime.onProgress,
      });
      expect(outcome).toMatchObject({ kind: "failed", message: failure.message });
      expect(runtime.calls.map((call) => call.kind)).toEqual(["upload"]);
    }
  });

  it("asks for the pending operation before resending bytes after an ambiguous transport error", async () => {
    // The row exists: the upload actually landed, so the drop goes straight to mount.
    const landed = transport({
      upload: () => Promise.reject(Object.assign(new Error("upload connection failed"), { ambiguous: true })),
      pending: jsonResponse(200, {
        operationId: OPERATION, projectId, assetPath: "assets/clip.mp4", state: "uploaded_unmounted",
      }),
    });
    const mounted = await dropFileOntoTimeline({
      ...placement, operationId: OPERATION, transport: landed.transport, onProgress: landed.onProgress,
    });
    expect(mounted).toMatchObject({ kind: "mounted" });
    expect(landed.calls.map((call) => call.kind)).toEqual(["upload", "pending", "mount"]);

    // No row: the bytes are resent under the same operation id, never a new one.
    const lost = transport({
      upload: (() => {
        let attempt = 0;
        return () => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject(Object.assign(new Error("upload connection failed"), { ambiguous: true }))
            : Promise.resolve({ path: "assets/clip.mp4", changeSeq: 3 });
        };
      })(),
    });
    const resent = await dropFileOntoTimeline({
      ...placement, operationId: OPERATION, transport: lost.transport, onProgress: lost.onProgress,
    });
    expect(resent).toMatchObject({ kind: "mounted" });
    expect(lost.calls.map((call) => call.kind)).toEqual(["upload", "pending", "upload", "mount"]);
    expect(new Set(lost.calls.filter((call) => call.kind === "upload").map((call) => call.body!.operationId)))
      .toEqual(new Set([OPERATION]));
  });

  it("leaves a failed mount as a retryable upload and keeps the file in Media", async () => {
    const runtime = transport({
      mount: () => jsonResponse(422, { error: { code: "invariant_violated", message: "the asset could not be inspected" } }),
    });
    const outcome = await dropFileOntoTimeline({
      ...placement, operationId: OPERATION, transport: runtime.transport, onProgress: runtime.onProgress,
    });
    expect(outcome).toEqual({
      kind: "uploaded_unmounted",
      operationId: OPERATION,
      assetPath: "assets/clip.mp4",
      message: "the asset could not be inspected",
      terminal: false,
    });

    // Retrying sends the operation id alone; the record owns where it goes.
    const retry = transport();
    const retried = await retryPendingMount({
      projectId, operationId: OPERATION, expectedContentHash: ENTRY_HASH, onOverflow: "extend-root",
      transport: retry.transport,
    });
    expect(retried).toMatchObject({ kind: "mounted", sceneId: "scene-2" });
    expect(retry.calls[0]!.body).toEqual({
      operationId: OPERATION, expectedContentHash: ENTRY_HASH, onOverflow: "extend-root",
    });
  });

  it("treats an expired operation as terminal instead of starting a new one", async () => {
    const runtime = transport({
      mount: () => jsonResponse(404, { error: { code: "not_found", message: "this upload can no longer be mounted" } }),
    });
    const outcome = await dropFileOntoTimeline({
      ...placement, operationId: OPERATION, transport: runtime.transport, onProgress: runtime.onProgress,
    });
    expect(outcome).toMatchObject({ kind: "uploaded_unmounted", terminal: true });
    expect(runtime.calls.map((call) => call.kind)).toEqual(["upload", "mount"]);
  });

  it("mounts an asset that is already in the project with one request and no operation", async () => {
    const runtime = transport();
    const outcome = await mountExistingAsset({
      ...placement,
      assetPath: "assets/clip.mp4",
      assetContentHash: `sha256:${"a".repeat(64)}`,
      transport: runtime.transport,
    });
    expect(outcome).toMatchObject({ kind: "mounted", sceneId: "scene-2" });
    expect(runtime.calls.map((call) => call.kind)).toEqual(["mount"]);
    expect(runtime.calls[0]!.body).toEqual({
      assetPath: "assets/clip.mp4",
      assetContentHash: `sha256:${"a".repeat(64)}`,
      atSeconds: 2,
      trackIndex: 0,
      expectedContentHash: ENTRY_HASH,
      onOverflow: "extend-root",
    });
  });

  it("reads the drop point off the pointer and clamps it to the timeline", () => {
    const surface = { surfaceLeft: 100, gutterPx: 40, pixelsPerSecond: 20, duration: 15, trackIndex: 1 };
    expect(dropPlacement({ ...surface, pointerX: 200 })).toEqual({ atSeconds: 3, trackIndex: 1 });
    // Dropped over the pinned gutter, or past the end: still a legal placement.
    expect(dropPlacement({ ...surface, pointerX: 110 })).toEqual({ atSeconds: 0, trackIndex: 1 });
    expect(dropPlacement({ ...surface, pointerX: 5_000 })).toEqual({ atSeconds: 15, trackIndex: 1 });
    expect(dropPlacement({ ...surface, pointerX: 200, pixelsPerSecond: 0 })).toEqual({ atSeconds: 0, trackIndex: 1 });
  });
});
