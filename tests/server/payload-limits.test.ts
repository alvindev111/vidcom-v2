import {
  MAX_BGM_BYTES,
  MAX_SOURCE_BYTES,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import { DEFAULT_PREVIEW_SETTINGS, ok, type AbsolutePath, type ProjectRef } from "@vidcom/core";
import { createServerApp, SESSION_COOKIE } from "@vidcom/server";
import { describe, expect, it } from "vitest";

const port = 43125;
const projectId = "payload_project" as ProjectId;
const contentHash = `sha256:${"0".repeat(64)}` as ContentHash;
const ref: ProjectRef = {
  id: projectId,
  slug: "payload",
  root: "/workspace/payload" as AbsolutePath,
  entry: "index.html" as RelPath,
};

function fixture() {
  const writes: unknown[] = [];
  const projectWrites = {
    workspace: {
      async readProjectRef() { return ref; },
    },
    authority: {
      async mutate(request: unknown) {
        writes.push(request);
        return ok({ path: "index.html", contentHash, revision: 1, diagnostics: [] });
      },
      async uploadBgm(request: unknown) {
        writes.push(request);
        return ok({
          path: null,
          contentHash,
          revision: 1,
          diagnostics: [],
          previewSettings: DEFAULT_PREVIEW_SETTINGS,
        });
      },
    },
    reads: {},
    composition: {},
    journal: {},
    clock: { now: () => new Date("2026-08-01T00:00:00.000Z") },
  };
  const app = createServerApp({
    port,
    uiOrigins: [],
    nonces: {} as never,
    sessions: { verify() { return { valid: true, renewed: false }; } } as never,
    projectWrites: projectWrites as never,
  });
  const request = (pathname: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    headers.set("Cookie", `${SESSION_COOKIE}=test-session`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  return { request, writes };
}

describe("advertised payload limits", () => {
  it("accepts source at 2 MiB and rejects the next byte with 413", async () => {
    const { request, writes } = fixture();
    const exact = await request(`/api/v1/projects/${projectId}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "index.html", content: "x".repeat(MAX_SOURCE_BYTES), expectedContentHash: null }),
    });
    expect(exact.status).toBe(200);
    expect(writes).toHaveLength(1);

    const oversized = await request(`/api/v1/projects/${projectId}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "index.html", content: "x".repeat(MAX_SOURCE_BYTES + 1), expectedContentHash: null }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "too_large" } });
    expect(writes).toHaveLength(1);
  });

  it("accepts BGM at 20 MiB, rejects the next byte, and requires an explicit revision", async () => {
    const { request, writes } = fixture();
    const body = (size: number, revision: string | null) => {
      const bytes = new Uint8Array(size);
      bytes.set([0x49, 0x44, 0x33]);
      const form = new FormData();
      form.append("file", new File([bytes], "track.mp3", { type: "audio/mpeg" }));
      if (revision !== null) form.append("expectedRevision", revision);
      return form;
    };
    const exact = await request(`/api/v1/projects/${projectId}/assets/bgm`, { method: "POST", body: body(MAX_BGM_BYTES, "0") });
    expect(exact.status).toBe(200);
    expect(writes).toHaveLength(1);

    const oversized = await request(`/api/v1/projects/${projectId}/assets/bgm`, { method: "POST", body: body(MAX_BGM_BYTES + 1, "0") });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "too_large" } });

    for (const revision of [null, ""]) {
      const missing = await request(`/api/v1/projects/${projectId}/assets/bgm`, { method: "POST", body: body(3, revision) });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: { code: "precondition_required" } });
    }
    expect(writes).toHaveLength(1);
  });
});
