// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  generateCaptions,
  ok,
  type AbsolutePath,
  type CompositionModel,
  type CompositionOp,
  type GenerateCaptionsDependencies,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const projectId = "project_captions" as ProjectId;
const expectedContentHash = `sha256:${"1".repeat(64)}` as ContentHash;
const writtenContentHash = `sha256:${"2".repeat(64)}` as ContentHash;
const ref: ProjectRef = {
  id: projectId,
  slug: "captions",
  root: "/workspace/captions" as AbsolutePath,
  entry: "index.html" as RelPath,
};

function model(): CompositionModel {
  return {
    project: {
      id: projectId,
      slug: "captions",
      title: "Captions",
      width: 1920,
      height: 1080,
      duration: 12,
      updatedAt: "2026-08-19T00:00:00.000Z",
      sceneCount: 1,
      revision: 3,
    },
    scenes: [{
      id: "scene-1",
      src: "compositions/scene-1.html",
      start: 4,
      duration: 5,
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
    sources: [{
      path: "compositions/scene-1.html" as RelPath,
      contentHash: expectedContentHash,
      byteSize: 128,
    }],
    references: [],
  };
}

function setup(sidecar: string | null = JSON.stringify({
  sceneId: "scene-1",
  cues: [
    {
      cueId: "cue-1",
      text: "Xin chào.",
      voice: "voice",
      offsetSeconds: 0.5,
      durationSeconds: 1,
      staleSince: null,
      words: [
        { text: "Xin", startSeconds: 0, endSeconds: 0.3 },
        { text: "chào.", startSeconds: 0.3, endSeconds: 0.8 },
      ],
      wordTimingSource: "engine",
    },
    {
      cueId: "cue-2",
      text: "Lại đây",
      voice: "voice",
      offsetSeconds: 2,
      durationSeconds: 1,
      staleSince: null,
      words: [{ text: "Lại", startSeconds: 0, endSeconds: 0.2 }, { text: "đây", startSeconds: 0.2, endSeconds: 0.6 }],
      wordTimingSource: "estimated",
    },
  ],
})) {
  const operations: CompositionOp[][] = [];
  const writes: unknown[] = [];
  const dependencies: GenerateCaptionsDependencies = {
    workspace: {
      async readProjectRef() { return ref; },
      async resolve(_ref, path) { return ok(path as ResolvedPath); },
      async readFile(path) {
        return path === "narration/scene-1.json" && sidecar !== null
          ? { content: sidecar, contentHash: expectedContentHash }
          : null;
      },
    },
    composition: {
      async parseProject() { return model(); },
      async applyOps(_ref, _file, next) {
        operations.push(next);
        return ok("<html>captions replaced</html>");
      },
    },
    authority: {
      async mutateSource(request) {
        writes.push(request);
        return ok({
          path: "compositions/scene-1.html" as RelPath,
          contentHash: writtenContentHash,
          revision: 4,
          diagnostics: [],
          changeSeq: 9,
        });
      },
    },
  };
  return { dependencies, operations, writes };
}

describe("generateCaptions", () => {
  it("plans all narration cues and performs one structured replacement plus one source mutation", async () => {
    const fixture = setup();
    const result = await generateCaptions(fixture.dependencies, {
      projectId,
      sceneId: "scene-1",
      expectedContentHash,
    }, "user");

    expect(result).toMatchObject({
      ok: true,
      value: {
        timingSource: "estimated",
        envelope: { projectRevision: 4, changeSeq: 9 },
      },
    });
    expect(fixture.operations).toHaveLength(1);
    expect(fixture.operations[0]).toEqual([{
      kind: "replaceCaptions",
      target: "scene-1",
      value: {
        timingSource: "estimated",
        cues: [
          {
            start: 0.5,
            end: 1.7,
            text: "Xin chào.",
            words: [
              { text: "Xin", start: 0.5, end: 0.8 },
              { text: "chào.", start: 0.8, end: 1.3 },
            ],
          },
          {
            start: 2,
            end: 3.2,
            text: "Lại đây",
            words: [{ text: "Lại", start: 2, end: 2.2 }, { text: "đây", start: 2.2, end: 2.6 }],
          },
        ],
      },
    }]);
    expect(fixture.writes).toEqual([expect.objectContaining({
      kind: "file",
      ref,
      path: "compositions/scene-1.html",
      content: "<html>captions replaced</html>",
      expectedContentHash,
    })]);
  });

  it("returns invariant_violated and performs no composition or source mutation without narration", async () => {
    const fixture = setup(null);
    const result = await generateCaptions(fixture.dependencies, {
      projectId,
      sceneId: "scene-1",
      expectedContentHash,
    }, "user");

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.InvariantViolated } });
    expect(fixture.operations).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
});
