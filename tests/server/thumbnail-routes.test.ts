// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ErrorCode, type ProjectId, type RelPath } from "@vidcom/contracts";
import { err, ok, type AbsolutePath, type ProjectRef } from "@vidcom/core";
import { createServerApp, SESSION_COOKIE } from "@vidcom/server";

const port = 43161;
const projectId = "thumbnail_routes" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "thumbnail-routes",
  root: "/workspace/thumbnail-routes" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const fingerprint = `sha256:${"a".repeat(64)}` as const;
const profile = { width: 160, height: 90, fps: 30, runtimeDigest: "runtime", rendererVersion: "renderer" };

function fixture(options: { graphUnavailable?: boolean; waitForAbort?: boolean } = {}) {
  const signalSeen: AbortSignal[] = [];
  const cacheGet = vi.fn(async (id: ProjectId, key: string) => id === projectId && key === "b".repeat(64)
    ? new Uint8Array([0x52, 0x49, 0x46, 0x46])
    : null);
  const plan = vi.fn(async (_ref: ProjectRef, input: { sceneId: string; atSeconds: number[]; profile: string }) => {
    if (options.graphUnavailable) {
      return err({ code: ErrorCode.DependencyGraphUnavailable, message: "graph unavailable" });
    }
    if (input.sceneId === "missing-scene") {
      return err({ code: ErrorCode.SceneNotFound, message: "scene was not found" });
    }
    if (input.atSeconds.some((at) => at >= 3)) {
      return err({ code: ErrorCode.SchemaInvalid, message: "mark is outside scene", field: "atSeconds" });
    }
    return ok({
      fingerprint,
      profile,
      keys: input.atSeconds.map((atSeconds) => ({ sceneId: input.sceneId, fingerprint, atSeconds, profile })),
    });
  });
  const requestPlanned = vi.fn(async (
    _ref: ProjectRef,
    _input: { sceneId: string; atSeconds: number[]; profile: string },
    planned: { keys: Array<{ atSeconds: number }> },
    signal: AbortSignal,
  ) => {
    signalSeen.push(signal);
    if (options.waitForAbort) {
      await new Promise<never>((_resolve, reject) => signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      ));
    }
    return planned.keys.map((key, index) => ({
      key,
      result: index === 1
        ? err({ code: ErrorCode.ThumbnailCapacity, message: "busy" })
        : index === 2
          ? err({ code: ErrorCode.SourceChanging, message: "changing" })
          : ok(new Uint8Array([index])),
    }));
  });
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces: {} as never,
    sessions: { verify() { return { valid: true, renewed: false }; } } as never,
    thumbnails: {
      workspace: { async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; } },
      service: { plan, renderKey: (key: { atSeconds: number }) => key.atSeconds === 2.5
        ? "d".repeat(64)
        : `${key.atSeconds}`.padStart(64, "a") },
      scheduler: { requestPlanned },
      cache: { get: cacheGet },
    } as never,
  });
  const request = (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    headers.set("Cookie", `${SESSION_COOKIE}=test-session`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  return { request, plan, requestPlanned, cacheGet, signalSeen };
}

async function post(runtime: ReturnType<typeof fixture>, body: unknown, signal?: AbortSignal) {
  return runtime.request(`/api/v1/projects/${projectId}/thumbnails`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

describe("timeline thumbnail routes", () => {
  it("streams exactly one ordered NDJSON line per requested mark", async () => {
    const runtime = fixture();
    const response = await post(runtime, { sceneId: "scene-1", atSeconds: [0, 1, 2, 2.5], profile: "timeline-v1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect((await response.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { atSeconds: 0, status: "ready", url: `/api/v1/projects/${projectId}/thumbnails/${"0".padStart(64, "a")}` },
      { atSeconds: 1, status: "placeholder", reason: ErrorCode.ThumbnailCapacity },
      { atSeconds: 2, status: "placeholder", reason: ErrorCode.SourceChanging },
      { atSeconds: 2.5, status: "ready", url: `/api/v1/projects/${projectId}/thumbnails/${"d".repeat(64)}` },
    ]);
    expect(runtime.requestPlanned).toHaveBeenCalledOnce();
  });

  it("rejects invalid transport shapes and out-of-duration marks before streaming", async () => {
    const runtime = fixture();
    const invalid = [
      { sceneId: "scene-1", atSeconds: [0, 0], profile: "timeline-v1" },
      { sceneId: "scene-1", atSeconds: Array.from({ length: 257 }, (_, index) => index), profile: "timeline-v1" },
      { sceneId: "scene-1", atSeconds: [0], profile: "unknown" },
      { sceneId: "scene-1", atSeconds: [0], profile: { name: "timeline-v1" } },
      { sceneId: "scene-1", atSeconds: [0], profile: "timeline-v1", otherSceneId: "scene-2" },
      { sceneId: "scene-1", atSeconds: [3], profile: "timeline-v1" },
    ];
    for (const body of invalid) {
      const response = await post(runtime, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: ErrorCode.SchemaInvalid } });
    }
    expect(runtime.requestPlanned).not.toHaveBeenCalled();
  });

  it("preflights project and scene ownership before opening the stream", async () => {
    const runtime = fixture();
    const missingProject = await runtime.request("/api/v1/projects/other-project/thumbnails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneId: "scene-1", atSeconds: [0], profile: "timeline-v1" }),
    });
    expect(missingProject.status).toBe(404);
    expect(await missingProject.json()).toMatchObject({ error: { code: ErrorCode.ProjectNotFound } });

    const missingScene = await post(runtime, {
      sceneId: "missing-scene", atSeconds: [0], profile: "timeline-v1",
    });
    expect(missingScene.status).toBe(422);
    expect(await missingScene.json()).toMatchObject({ error: { code: ErrorCode.SceneNotFound } });
    expect(runtime.requestPlanned).not.toHaveBeenCalled();
  });

  it("turns a fail-closed dependency graph into stable placeholders", async () => {
    const runtime = fixture({ graphUnavailable: true });
    const response = await post(runtime, { sceneId: "scene-1", atSeconds: [0, 1], profile: "timeline-v1" });
    expect(response.status).toBe(200);
    expect((await response.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { atSeconds: 0, status: "placeholder", reason: ErrorCode.DependencyGraphUnavailable },
      { atSeconds: 1, status: "placeholder", reason: ErrorCode.DependencyGraphUnavailable },
    ]);
    expect(runtime.requestPlanned).not.toHaveBeenCalled();
  });

  it("serves only project-namespaced lowercase cache keys as immutable WebP", async () => {
    const runtime = fixture();
    const key = "b".repeat(64);
    const hit = await runtime.request(`/api/v1/projects/${projectId}/thumbnails/${key}`, {
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "image",
      },
    });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toBe("image/webp");
    expect(hit.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    expect(runtime.cacheGet).toHaveBeenCalledWith(projectId, key);

    expect((await runtime.request(`/api/v1/projects/${projectId}/thumbnails/${"c".repeat(64)}`)).status).toBe(404);
    expect((await runtime.request(`/api/v1/projects/other-project/thumbnails/${key}`)).status).toBe(404);
    expect(runtime.cacheGet).toHaveBeenCalledWith("other-project", key);
    const calls = runtime.cacheGet.mock.calls.length;
    expect((await runtime.request(`/api/v1/projects/${projectId}/thumbnails/${"A".repeat(64)}`)).status).toBe(400);
    expect(runtime.cacheGet).toHaveBeenCalledTimes(calls);
  });

  it("passes the request AbortSignal to the prepared scheduler batch", async () => {
    const runtime = fixture({ waitForAbort: true });
    const controller = new AbortController();
    const response = await post(
      runtime,
      { sceneId: "scene-1", atSeconds: [0], profile: "timeline-v1" },
      controller.signal,
    );
    expect(runtime.signalSeen).toHaveLength(1);
    expect(runtime.signalSeen[0]?.aborted).toBe(false);
    controller.abort();
    await vi.waitFor(() => expect(runtime.signalSeen[0]?.aborted).toBe(true));
    await response.text();
  });

  it("aborts the prepared batch when the response stream disconnects", async () => {
    const runtime = fixture({ waitForAbort: true });
    const response = await post(runtime, { sceneId: "scene-1", atSeconds: [0], profile: "timeline-v1" });
    expect(runtime.signalSeen[0]?.aborted).toBe(false);
    await response.body?.cancel();
    await vi.waitFor(() => expect(runtime.signalSeen[0]?.aborted).toBe(true));
  });
});
