// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  deleteSceneSelection,
  prepareSceneSelectionDeletion,
  saveSceneGroupMove,
  saveSceneReorder,
  type SceneOrderRequest,
} from "../../src/lib/studio/scene-order-mutation";

const hash = `sha256:${"a".repeat(64)}`;

describe("scene order browser mutations", () => {
  it("builds one reorder and one group-move request with exact source identity", async () => {
    const requests: SceneOrderRequest[] = [];
    const send = async (request: SceneOrderRequest) => {
      requests.push(request);
      return new Response(JSON.stringify({
        changed: true,
        file: { path: "index.html", contentHash: hash },
        revision: 4,
        diagnostics: [],
        changeSeq: 9,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await saveSceneReorder({
      projectId: "project-a", expectedContentHash: hash, sceneId: "a", toIndex: 1, send,
    });
    await saveSceneGroupMove({
      projectId: "project-a", expectedContentHash: hash, sceneIds: ["a", "c"], deltaSeconds: 0.5, send,
    });
    expect(requests).toEqual([
      {
        path: "/api/v1/projects/project-a/scenes/order",
        method: "PATCH",
        body: { sceneId: "a", toIndex: 1, expectedContentHash: hash },
      },
      {
        path: "/api/v1/projects/project-a/scenes/move",
        method: "POST",
        body: { sceneIds: ["a", "c"], deltaSeconds: 0.5, expectedContentHash: hash },
      },
    ]);
  });

  it("prepares then executes deletion with the identical ordered intent", async () => {
    const requests: SceneOrderRequest[] = [];
    const send = async (request: SceneOrderRequest) => {
      requests.push(request);
      return new Response(JSON.stringify(request.path.endsWith("/deletions")
        ? { grantId: "grant-a", plan: { sceneIds: ["a", "c"] } }
        : { project: { sceneCount: 0 }, revision: 5, diagnostics: [], changeSeq: 10, backupId: "backup-a", deletedFiles: [], keptFiles: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const prepared = await prepareSceneSelectionDeletion({
      projectId: "project-a", sceneIds: ["c", "a"], expectedRevision: 4, send,
    });
    expect(prepared).toMatchObject({ kind: "prepared", grantId: "grant-a", sceneIds: ["a", "c"] });
    await deleteSceneSelection({
      projectId: "project-a", sceneIds: prepared.kind === "prepared" ? prepared.sceneIds : [],
      expectedRevision: 4, grantId: "grant-a", send,
    });
    expect(requests).toEqual([
      {
        path: "/api/v1/projects/project-a/scenes/deletions",
        method: "POST",
        body: { sceneIds: ["a", "c"], expectedRevision: 4 },
      },
      {
        path: "/api/v1/projects/project-a/scenes/deletions/grant-a",
        method: "POST",
        body: { sceneIds: ["a", "c"], expectedRevision: 4 },
      },
    ]);
  });
});
