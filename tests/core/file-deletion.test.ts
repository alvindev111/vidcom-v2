import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  deleteFile,
  prepareFileDeletion,
  type AbsolutePath,
  type CompositionModel,
  type CompositionReference,
  type CompositeRequest,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const projectId = "project_file_delete" as ProjectId;
const hash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}` as ContentHash;
const ref: ProjectRef = {
  id: projectId,
  slug: "delete",
  root: "/workspace/delete" as AbsolutePath,
  entry: "index.html" as RelPath,
};

function model(references: CompositionReference[] = []): CompositionModel {
  return {
    project: {
      id: projectId,
      slug: "delete",
      title: "Delete",
      width: 1920,
      height: 1080,
      duration: 4,
      updatedAt: "2026-08-02T00:00:00.000Z",
      sceneCount: 1,
      revision: 4,
    },
    scenes: [{
      id: "scene-1",
      src: null,
      start: 0,
      duration: 4,
      trackIndex: 1,
      block: null,
      isTransition: false,
      media: [],
      script: [],
      narration: null,
      elements: [],
      unresolvedEffects: 0,
    }],
    rootTrack: null,
    diagnostics: [],
    sources: [{ path: "index.html" as RelPath, contentHash: hash("1"), byteSize: 100 }],
    references,
  };
}

function dependencies(options: {
  currentHash?: ContentHash | null;
  references?: CompositionReference[];
} = {}) {
  return {
    workspace: {
      async readProjectRef() { return ref; },
      async resolve(_ref: ProjectRef, path: string) { return { ok: true as const, value: path as ResolvedPath }; },
      async readHash() { return options.currentHash === undefined ? hash("2") : options.currentHash; },
    },
    composition: { async parseProject() { return model(options.references); } },
    journal: { async latestRevision() { return 4; } },
    hashContent: () => hash("f"),
  };
}

describe("prepareFileDeletion", () => {
  it("builds a canonical single-target plan and approval binding without writing", async () => {
    const prepared = await prepareFileDeletion(dependencies(), {
      projectId,
      path: "notes.txt" as RelPath,
      expectedContentHash: hash("2"),
    });
    expect(prepared).toEqual({
      ok: true,
      value: {
        plan: {
          path: "notes.txt",
          expectedContentHash: hash("2"),
          targetHashes: { "notes.txt": hash("2") },
          diagnostics: [],
        },
        binding: {
          tool: "delete_file",
          projectId,
          target: "notes.txt",
          expectedRevision: 4,
          planDigest: hash("f"),
          targetHashes: { "notes.txt": hash("2") },
        },
      },
    });
  });

  it("rejects protected paths before filesystem reads", async () => {
    await expect(prepareFileDeletion(dependencies(), {
      projectId,
      path: "hyperframes.json" as RelPath,
      expectedContentHash: hash("2"),
    })).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.AssetNotAllowed } });
  });

  it("rejects current hash conflicts with the latest revision", async () => {
    await expect(prepareFileDeletion(dependencies({ currentHash: hash("3") }), {
      projectId,
      path: "notes.txt" as RelPath,
      expectedContentHash: hash("2"),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.WriteConflict, details: { current: { contentHash: hash("3"), revision: 4 } } },
    });
  });

  it("rejects files still referenced as composition sources", async () => {
    await expect(prepareFileDeletion(dependencies({
      references: [{ path: "notes.txt" as RelPath, owner: "index.html" as RelPath }],
    }), {
      projectId,
      path: "notes.txt" as RelPath,
      expectedContentHash: hash("2"),
    })).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.ReferencedByComposition } });
  });

  it("rejects nested and root-track references without confusing equal basenames", async () => {
    const references: CompositionReference[] = [
      { owner: "compositions/scene.html" as RelPath, path: "assets/logo.svg" as RelPath },
      { owner: "index.html" as RelPath, path: "assets/root.svg" as RelPath },
      { owner: "compositions/scene.html" as RelPath, path: "compositions/logo.svg" as RelPath },
    ];
    for (const referenced of ["assets/logo.svg", "assets/root.svg", "compositions/logo.svg"] as RelPath[]) {
      await expect(prepareFileDeletion(dependencies({ references }), {
        projectId,
        path: referenced,
        expectedContentHash: hash("2"),
      })).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.ReferencedByComposition } });
    }
    await expect(prepareFileDeletion(dependencies({ references }), {
      projectId,
      path: "other/logo.svg" as RelPath,
      expectedContentHash: hash("2"),
    })).resolves.toMatchObject({ ok: true });
  });
});

describe("deleteFile", () => {
  it("re-plans and executes the approved target as one backed-up delete", async () => {
    const base = dependencies();
    const prepared = await prepareFileDeletion(base, {
      projectId,
      path: "notes.txt" as RelPath,
      expectedContentHash: hash("2"),
    });
    if (!prepared.ok) throw new Error("file plan failed");
    const requests: CompositeRequest[] = [];
    const deleted = await deleteFile({
      ...base,
      authority: {
        async mutateComposite(request) {
          requests.push(request);
          return {
            ok: true as const,
            value: {
              projectRevision: 5,
              entityRevision: null,
              fileHashes: {},
              diagnostics: [],
              backupId: "backup_file_1",
            },
          };
        },
      },
    }, { projectId, plan: prepared.value.plan, grantId: "grant_file_1" }, "agent");

    expect(deleted).toEqual({
      ok: true,
      value: {
        deleted: "notes.txt",
        envelope: { projectRevision: 5, entityRevision: null, fileHashes: {}, diagnostics: [] },
        backupId: "backup_file_1",
      },
    });
    expect(requests).toMatchObject([{
      backup: true,
      grant: { id: "grant_file_1", binding: { tool: "delete_file", expectedRevision: 4 } },
      steps: [{ kind: "delete", path: "notes.txt", expectedContentHash: hash("2") }],
    }]);
  });

  it("rejects a caller-modified approved plan before authority", async () => {
    const base = dependencies();
    const requests: CompositeRequest[] = [];
    const result = await deleteFile({
      ...base,
      authority: {
        async mutateComposite(request) {
          requests.push(request);
          throw new Error("must not mutate");
        },
      },
    }, {
      projectId,
      grantId: "grant_file_1",
      plan: {
        path: "notes.txt" as RelPath,
        expectedContentHash: hash("2"),
        targetHashes: { ["notes.txt" as RelPath]: hash("2") },
        diagnostics: [{ severity: "info", code: "tampered", message: "tampered" }],
      },
    }, "agent");
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.ApprovalInvalid } });
    expect(requests).toHaveLength(0);
  });
});
