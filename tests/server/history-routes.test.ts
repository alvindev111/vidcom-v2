// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ok,
  type AbsolutePath,
  type CompositeRequest,
  type MutationReceipt,
  type ProjectRef,
  type UndoContentPort,
  type UndoContentRef,
  type WriteInvocation,
} from "@vidcom/core";
import {
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  MutationHistory,
  SESSION_COOKIE,
} from "@vidcom/server";

const port = 43139;
const projectId = "project_history_routes" as ProjectId;
const studioId = "01K1ABCDEFGHJKMNPQRSTVWXYZ";
const ref: ProjectRef = {
  id: projectId,
  slug: "history-routes",
  root: "/workspace/history-routes" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const contentHash = `sha256:${"a".repeat(64)}` as ContentHash;

function historyReceipt(id: string): MutationReceipt {
  const content: UndoContentRef = {
    kind: "inline",
    bytes: new TextEncoder().encode("before"),
    encoding: "utf8",
    contentHash,
  };
  return {
    id,
    projectId,
    origin: {
      kind: "ui",
      sessionId: studioId,
      label: "Edit source",
      historyAction: "record",
      historyOperation: null,
    },
    steps: [{
      kind: "file",
      undoable: true,
      path: "index.html" as RelPath,
      beforeContent: content,
      afterContent: content,
      fromHash: contentHash,
      toHash: contentHash,
    }],
    paths: ["index.html" as RelPath],
    readGuards: [],
    projectRevision: 1,
    at: "2026-08-18T00:00:00.000Z",
    undoable: true,
  };
}

function fixture() {
  const clock = { now: () => new Date("2026-08-18T00:00:00.000Z") };
  const sessions = new InMemorySessionStore(clock, () => Buffer.alloc(32, 7));
  const { token } = sessions.mint({ absoluteTtlMs: 60_000, idleTtlMs: 60_000 });
  const browserId = sessions.fingerprint(token)!;
  const releases: UndoContentRef[][] = [];
  const content: UndoContentPort = {
    async retainBytes() { throw new Error("not used"); },
    async retainFile() { throw new Error("not used"); },
    async resolve(value) { return value.kind === "inline" ? value.bytes : { sourcePath: "/object" as AbsolutePath, contentHash: value.contentHash }; },
    release(refs) { releases.push([...refs]); },
  };
  const history = new MutationHistory(content, { operationId: () => "operation-route" });
  const writes: Array<{ request: CompositeRequest | { path: RelPath; content: string }; invocation?: WriteInvocation }> = [];
  let releaseInverse = () => {};
  let holdInverse = false;
  let blockInverse = false;
  const inverseHeld = new Promise<void>((resolve) => { releaseInverse = resolve; });
  let markStarted = () => {};
  const inverseStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const authority = {
    async mutateSource(
      request: CompositeRequest | { path: RelPath; content: string },
      _actor: unknown,
      invocation?: WriteInvocation,
    ) {
      if (!("steps" in request)) {
        writes.push({ request, invocation });
        return ok({ path: request.path, contentHash, revision: 2, diagnostics: [] });
      }
      writes.push({ request, invocation });
      if (blockInverse) {
        history.blockHistoryOperation(projectId, request.origin, ["index.html" as RelPath]);
        return { ok: false as const, error: { code: ErrorCode.WriteConflict, message: "source changed" } };
      }
      const claimed = history.claimHistoryOperation(projectId, request.origin);
      if (!claimed.ok) return { ok: false as const, error: { code: ErrorCode.WriteConflict, message: claimed.reason } };
      markStarted();
      if (holdInverse) await inverseHeld;
      const inverse = historyReceipt(`inverse-${writes.length}`);
      inverse.origin = request.origin;
      history.emit(inverse);
      return ok({
        projectRevision: 2,
        entityRevision: null,
        fileHashes: { ["index.html" as RelPath]: contentHash },
        diagnostics: [],
        changeSeq: 2,
        inverseReceipt: inverse,
      });
    },
  };
  const projectWrites = {
    workspace: { async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; } },
    composition: {},
    journal: { async readEntityState() { return null; } },
    authority,
    clock,
    undoContent: content,
    reads: {},
  };
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces: new InMemoryNonceStore(clock),
    sessions,
    history,
    browserSessionId: () => browserId,
    projectWrites: projectWrites as never,
  });
  const request = (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    headers.set("Cookie", `${SESSION_COOKIE}=${token}`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  return {
    history,
    browserId,
    writes,
    request,
    hold() { holdInverse = true; },
    block() { blockInverse = true; },
    release() { releaseInverse(); },
    started() { return inverseStarted; },
  };
}

const sessionHeaders = { "x-vidcom-studio-session": studioId };

describe("browser history routes", () => {
  it("requires a valid studio header and binds attach to the authenticated browser", async () => {
    const runtime = fixture();
    const missing = await runtime.request(`/api/v1/projects/${projectId}/history/session`, { method: "POST" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "precondition_required" } });

    const invalid = await runtime.request(`/api/v1/projects/${projectId}/history/session`, {
      method: "POST",
      headers: { "x-vidcom-studio-session": "not-a-ulid" },
    });
    expect(invalid.status).toBe(400);

    const attached = await runtime.request(`/api/v1/projects/${projectId}/history/session`, {
      method: "POST",
      headers: sessionHeaders,
    });
    expect(attached.status).toBe(204);
    expect(runtime.history.isAttached(runtime.browserId, studioId, projectId)).toBe(true);

    const state = await runtime.request(`/api/v1/projects/${projectId}/history`, { headers: sessionHeaders });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ canUndo: false, canRedo: false, busy: false, depth: 0 });
  });

  it("rejects missing/unattached headers before a browser project write and supplies a server-owned record origin", async () => {
    const runtime = fixture();
    const body = JSON.stringify({ path: "index.html", content: "next", expectedContentHash: contentHash });
    const missing = await runtime.request(`/api/v1/projects/${projectId}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(missing.status).toBe(400);
    expect(runtime.writes).toEqual([]);

    const unattached = await runtime.request(`/api/v1/projects/${projectId}/files`, {
      method: "PUT",
      headers: { ...sessionHeaders, "Content-Type": "application/json" },
      body,
    });
    expect(unattached.status).toBe(400);
    expect(runtime.writes).toEqual([]);

    await runtime.request(`/api/v1/projects/${projectId}/history/session`, { method: "POST", headers: sessionHeaders });
    const written = await runtime.request(`/api/v1/projects/${projectId}/files`, {
      method: "PUT",
      headers: { ...sessionHeaders, "Content-Type": "application/json" },
      body,
    });
    expect(written.status).toBe(200);
    expect(runtime.writes).toHaveLength(1);
    expect(runtime.writes[0]?.invocation).toMatchObject({
      origin: { kind: "ui", sessionId: studioId, historyAction: "record", historyOperation: null },
    });
    expect(runtime.writes[0]?.invocation?.origin.label).toBe("Edit source");

    const crossProject = await runtime.request("/api/v1/projects/project_other/files", {
      method: "PUT",
      headers: { ...sessionHeaders, "Content-Type": "application/json" },
      body,
    });
    expect(crossProject.status).toBe(400);
    expect(runtime.writes).toHaveLength(1);
  });

  it("runs undo through one reservation and exposes the moved original as redo", async () => {
    const runtime = fixture();
    await runtime.request(`/api/v1/projects/${projectId}/history/session`, { method: "POST", headers: sessionHeaders });
    expect(runtime.history.emit(historyReceipt("receipt-original"))).toEqual({ ok: true });

    const response = await runtime.request(`/api/v1/projects/${projectId}/undo`, { method: "POST", headers: sessionHeaders });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applied: "undo",
      revision: 2,
      state: { canUndo: false, canRedo: true, busy: false, nextRedoLabel: "Edit source" },
    });
    expect(runtime.writes).toHaveLength(1);
    expect(runtime.writes[0]?.request).toMatchObject({
      origin: {
        kind: "ui",
        sessionId: studioId,
        historyAction: "undo",
        historyOperation: { id: "operation-route", targetReceiptId: "receipt-original" },
      },
    });
  });

  it("returns 409 and zero second write for concurrent undo on one stack", async () => {
    const runtime = fixture();
    await runtime.request(`/api/v1/projects/${projectId}/history/session`, { method: "POST", headers: sessionHeaders });
    runtime.history.emit(historyReceipt("receipt-original"));
    runtime.hold();
    const first = runtime.request(`/api/v1/projects/${projectId}/undo`, { method: "POST", headers: sessionHeaders });
    await runtime.started();
    const second = await runtime.request(`/api/v1/projects/${projectId}/undo`, { method: "POST", headers: sessionHeaders });
    expect(second.status).toBe(409);
    expect(runtime.writes).toHaveLength(1);
    runtime.release();
    expect((await first).status).toBe(200);
  });

  it("settles a synchronous precondition conflict, blocks the top and rejects retry before authority", async () => {
    const runtime = fixture();
    await runtime.request(`/api/v1/projects/${projectId}/history/session`, { method: "POST", headers: sessionHeaders });
    runtime.history.emit(historyReceipt("receipt-original"));
    runtime.block();

    const conflicted = await runtime.request(`/api/v1/projects/${projectId}/undo`, { method: "POST", headers: sessionHeaders });
    expect(conflicted.status).toBe(409);
    expect(runtime.history.state(studioId, projectId)).toMatchObject({
      canUndo: false,
      busy: false,
      depth: 1,
      undoBlocked: true,
      undoBlockedReason: "source-changed-externally",
    });
    expect(runtime.writes).toHaveLength(1);

    const retry = await runtime.request(`/api/v1/projects/${projectId}/undo`, { method: "POST", headers: sessionHeaders });
    expect(retry.status).toBe(409);
    expect(runtime.writes).toHaveLength(1);
  });

  it("explicit detach clears history and prevents SSE-only resurrection", async () => {
    const runtime = fixture();
    await runtime.request(`/api/v1/projects/${projectId}/history/session`, { method: "POST", headers: sessionHeaders });
    runtime.history.emit(historyReceipt("receipt-original"));

    const detached = await runtime.request(`/api/v1/projects/${projectId}/history/session`, {
      method: "DELETE",
      headers: sessionHeaders,
    });
    expect(detached.status).toBe(204);
    const state = await runtime.request(`/api/v1/projects/${projectId}/history`, { headers: sessionHeaders });
    expect(state.status).toBe(400);
  });
});
