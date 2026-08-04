import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type SceneDto } from "@vidcom/contracts";
import {
  err,
  ok,
  synthesizeNarration,
  type CompositeStep,
  type CompositionModel,
  type ProjectRef,
  type Result,
  type SynthesizedCue,
  type SynthesizeNarrationDependencies,
  type TtsSynthesisRequest,
  type WriteEnvelope,
} from "@vidcom/core";
import type { DomainError } from "@vidcom/contracts";

import { createFixedClock } from "../support/deterministic";

const PROJECT_ID = "demo" as ProjectId;
const REF: ProjectRef = { id: PROJECT_ID, slug: "demo", root: "/workspace/demo" } as ProjectRef;

function scene(id: string, narrationText: string | null): SceneDto {
  return {
    id,
    src: `compositions/${id}.html`,
    start: 0,
    duration: 5,
    trackIndex: 0,
    block: null,
    isTransition: false,
    media: [],
    script: [],
    narration: narrationText === null ? null : {
      sceneId: id,
      text: narrationText,
      voice: "af_heart",
      status: "mock",
      audioPath: `narration/${id}.wav`,
      command: "",
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      staleSince: null,
    },
    elements: [],
    unresolvedEffects: 0,
  };
}

interface Harness {
  dependencies: SynthesizeNarrationDependencies;
  committed: CompositeStep[][];
  requests: TtsSynthesisRequest[];
}

function harness(options: {
  scenes: SceneDto[];
  synthesize?: (request: TtsSynthesisRequest) => Result<readonly SynthesizedCue[], DomainError>;
  existingHashes?: Record<string, ContentHash>;
}): Harness {
  const committed: CompositeStep[][] = [];
  const requests: TtsSynthesisRequest[] = [];
  const hashes = options.existingHashes ?? {};
  return {
    committed,
    requests,
    dependencies: {
      workspace: {
        readProjectRef: async () => REF,
        resolve: async (_ref: ProjectRef, path: string) => ok({ relative: path, absolute: `${REF.root}/${path}` }),
        readHash: async (resolved: { relative: string }) => hashes[resolved.relative] ?? null,
      },
      composition: {
        parseProject: async (): Promise<CompositionModel> => ({
          project: {} as CompositionModel["project"],
          scenes: options.scenes,
          rootTrack: null,
          diagnostics: [],
          sources: [],
          references: [],
        }),
      },
      journal: {} as SynthesizeNarrationDependencies["journal"],
      authority: {
        mutateSource: async (request: { steps: CompositeStep[] }): Promise<Result<WriteEnvelope, DomainError>> => {
          committed.push(request.steps);
          return ok({
            projectRevision: 12,
            entityRevision: null,
            fileHashes: {},
            diagnostics: [],
          } as WriteEnvelope);
        },
        mutate: async () => { throw new Error("mutate must not be used for a batch"); },
      },
      clock: createFixedClock("2026-08-03T10:00:00.000Z"),
      tts: {
        listProviders: async () => [],
        synthesize: async (request: TtsSynthesisRequest) => {
          requests.push(request);
          return options.synthesize
            ? options.synthesize(request)
            : ok(request.cues.map((cue): SynthesizedCue => ({
                cueId: cue.id,
                audio: new Uint8Array([1, 2, 3]),
                durationSeconds: 4.5,
                words: [],
                metadata: {},
              })));
        },
      },
    } as unknown as SynthesizeNarrationDependencies,
  };
}

const INPUT = {
  projectId: PROJECT_ID,
  sceneIds: ["intro"],
  providerId: "vieneu",
  voiceId: "vieneu-v3-doan-trang",
  modelId: null,
  ratePercent: 0,
  computeDevice: "cpu" as const,
};

describe("synthesizeNarration", () => {
  it("publishes audio and sidecar for every scene in one composite mutation", async () => {
    const { dependencies, committed } = harness({
      scenes: [scene("intro", "Xin chào"), scene("outro", "Tạm biệt")],
    });

    const result = await synthesizeNarration(dependencies, {
      ...INPUT, sceneIds: ["intro", "outro"],
    }, "user");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revision).toBe(12);
    expect(result.value.assets).toEqual([
      { sceneId: "intro", path: "narration/intro.wav", durationSeconds: 4.5 },
      { sceneId: "outro", path: "narration/outro.wav", durationSeconds: 4.5 },
    ]);
    // One mutation, not one per scene: a half-voiced project is not a state the
    // user should ever be able to observe.
    expect(committed).toHaveLength(1);
    expect(committed[0]?.map((step) => step.kind === "write" ? step.path : step.kind)).toEqual([
      "narration/intro.wav",
      "narration/intro.json",
      "narration/outro.wav",
      "narration/outro.json",
    ]);
  });

  it("writes a generated sidecar carrying the engine, duration and bumped revision", async () => {
    const { dependencies, committed } = harness({ scenes: [scene("intro", "Xin chào")] });

    await synthesizeNarration(dependencies, INPUT, "user");

    const sidecar = committed[0]?.[1];
    if (sidecar?.kind !== "write" || typeof sidecar.content !== "string") throw new Error("sidecar step missing");
    expect(JSON.parse(sidecar.content)).toMatchObject({
      sceneId: "intro",
      status: "generated",
      provider: "vieneu",
      voice: "vieneu-v3-doan-trang",
      durationSeconds: 4.5,
      // The mock sidecar was at revision 3.
      revision: 4,
      staleSince: null,
      updatedAt: "2026-08-03T10:00:00.000Z",
    });
  });

  it("persists the engine's own word timings and marks them measured", async () => {
    const words = [
      { text: "Xin", startSeconds: 0, endSeconds: 0.4 },
      { text: "chào", startSeconds: 0.4, endSeconds: 0.9 },
    ];
    const { dependencies, committed } = harness({
      scenes: [scene("intro", "Xin chào")],
      synthesize: (request) => ok(request.cues.map((cue): SynthesizedCue => ({
        cueId: cue.id,
        audio: new Uint8Array([1]),
        durationSeconds: 1,
        words,
        metadata: {},
      }))),
    });

    await synthesizeNarration(dependencies, INPUT, "user");

    const sidecar = committed[0]?.[1];
    if (sidecar?.kind !== "write" || typeof sidecar.content !== "string") throw new Error("sidecar step missing");
    expect(JSON.parse(sidecar.content)).toMatchObject({ words, wordTimingSource: "engine" });
  });

  it("estimates word timings for an engine that reports none, so highlighting still works", async () => {
    const { dependencies, committed } = harness({ scenes: [scene("intro", "Xin chào các bạn")] });

    await synthesizeNarration(dependencies, INPUT, "user");

    const sidecar = committed[0]?.[1];
    if (sidecar?.kind !== "write" || typeof sidecar.content !== "string") throw new Error("sidecar step missing");
    const record = JSON.parse(sidecar.content) as {
      words: { text: string }[];
      wordTimingSource: string;
    };
    // VieNeu has no alignment; without an estimate the local Vietnamese engine
    // could never drive word-level transcript highlighting.
    expect(record.words.map((word) => word.text)).toEqual(["Xin", "chào", "các", "bạn"]);
    expect(record.wordTimingSource).toBe("estimated");
  });

  it("refuses to publish word timings that overrun their audio", async () => {
    const { dependencies, committed } = harness({
      scenes: [scene("intro", "Xin chào")],
      synthesize: (request) => ok(request.cues.map((cue): SynthesizedCue => ({
        cueId: cue.id,
        audio: new Uint8Array([1]),
        durationSeconds: 1,
        words: [{ text: "Xin", startSeconds: 0, endSeconds: 9 }],
        metadata: {},
      }))),
    });

    const result = await synthesizeNarration(dependencies, INPUT, "user");

    // A caption built from out-of-range boundaries drifts visibly and the cause
    // is very hard to see from the symptom.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsSynthesisFailed);
    expect(result.error.details).toMatchObject({ sceneId: "intro" });
    expect(committed).toHaveLength(0);
  });

  it("carries the existing file hashes as write preconditions", async () => {
    const hash = "sha256:0000000000000000000000000000000000000000000000000000000000000001" as ContentHash;
    const { dependencies, committed } = harness({
      scenes: [scene("intro", "Xin chào")],
      existingHashes: { "narration/intro.json": hash },
    });

    await synthesizeNarration(dependencies, INPUT, "user");

    const [audio, sidecar] = committed[0] ?? [];
    expect(audio?.kind === "write" && audio.expectedContentHash).toBe(null);
    expect(sidecar?.kind === "write" && sidecar.expectedContentHash).toBe(hash);
  });

  it("writes nothing when the engine fails", async () => {
    const { dependencies, committed } = harness({
      scenes: [scene("intro", "Xin chào")],
      synthesize: () => err({ code: ErrorCode.TtsQuotaExceeded, message: "out of credits" }),
    });

    const result = await synthesizeNarration(dependencies, INPUT, "user");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsQuotaExceeded);
    expect(committed).toHaveLength(0);
  });

  it("writes nothing when the engine silently skips a cue", async () => {
    const { dependencies, committed } = harness({
      scenes: [scene("intro", "Xin chào"), scene("outro", "Tạm biệt")],
      synthesize: (request) => ok([{
        cueId: request.cues[0]!.id,
        audio: new Uint8Array([1]),
        durationSeconds: 1,
        words: [],
        metadata: {},
      }]),
    });

    const result = await synthesizeNarration(dependencies, {
      ...INPUT, sceneIds: ["intro", "outro"],
    }, "user");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsSynthesisFailed);
    expect(committed).toHaveLength(0);
  });

  it("rejects a scene that is not in the project before calling the engine", async () => {
    const { dependencies, requests } = harness({ scenes: [scene("intro", "Xin chào")] });

    const result = await synthesizeNarration(dependencies, { ...INPUT, sceneIds: ["ghost"] }, "user");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.SceneNotFound);
    expect(requests).toHaveLength(0);
  });

  it("rejects a scene whose narration has never been written", async () => {
    const { dependencies, requests } = harness({ scenes: [scene("intro", null)] });

    const result = await synthesizeNarration(dependencies, INPUT, "user");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NotFound);
    expect(requests).toHaveLength(0);
  });

  it("rejects a batch that names the same scene twice", async () => {
    const { dependencies, requests } = harness({ scenes: [scene("intro", "Xin chào")] });

    const result = await synthesizeNarration(dependencies, {
      ...INPUT, sceneIds: ["intro", "intro"],
    }, "user");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Two write steps for one path would be rejected by the write authority
    // anyway; catching it here names the actual mistake.
    expect(result.error.code).toBe(ErrorCode.DuplicateMutationTarget);
    expect(requests).toHaveLength(0);
  });
});
