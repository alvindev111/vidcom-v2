// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  saveSceneTiming,
  type TimingRequest,
} from "../../src/lib/studio/scene-timing-mutation";

const commit = { sceneId: "scene-a", timing: { start: 2.5 }, ripple: false };

describe("scene timing mutation", () => {
  it("sends exactly one hash-preconditioned request for a changed drop", async () => {
    const requests: TimingRequest[] = [];
    const result = await saveSceneTiming({
      projectId: "project-a",
      expectedContentHash: "sha256:current",
      commit,
      send: async (request) => {
        requests.push(request);
        return new Response(JSON.stringify({
          file: { path: "index.html", contentHash: "sha256:next" },
          changeSeq: 12,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/v1/projects/project-a/scenes/scene-a",
      body: {
        timing: { start: 2.5 },
        ripple: false,
        expectedContentHash: "sha256:current",
      },
    });
    expect(result).toEqual({
      kind: "saved",
      file: { path: "index.html", contentHash: "sha256:next" },
      changeSeq: 12,
    });
  });

  it("does not request when the reducer produced no commit", async () => {
    let requests = 0;
    const result = await saveSceneTiming({
      projectId: "project-a",
      expectedContentHash: "sha256:current",
      commit: null,
      send: async () => { requests += 1; return new Response(); },
    });
    expect(result).toEqual({ kind: "no-change" });
    expect(requests).toBe(0);
  });

  it("classifies conflict and the two overflow boundaries without hiding details", async () => {
    const response = (status: number, details: Record<string, unknown>) => new Response(JSON.stringify({
      error: { code: status === 409 ? "write_conflict" : "duration_overflow", message: "timing rejected", details },
    }), { status, headers: { "content-type": "application/json" } });
    const run = (status: number, details: Record<string, unknown>) => saveSceneTiming({
      projectId: "project-a", expectedContentHash: "sha256:current", commit,
      send: async () => response(status, details),
    });

    await expect(run(409, {})).resolves.toMatchObject({ kind: "source-conflict" });
    await expect(run(422, { limitKind: "root", extendRootAllowed: true }))
      .resolves.toMatchObject({ kind: "root-overflow", canExtendRoot: true });
    await expect(run(422, { limitKind: "runtime", extendRootAllowed: false }))
      .resolves.toMatchObject({ kind: "runtime-overflow", canExtendRoot: false });
  });
});
