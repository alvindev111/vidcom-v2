import { describe, expect, it } from "vitest";

import { ErrorCode, type DomainError, type ProjectId } from "@vidcom/contracts";
import {
  err,
  ok,
  JobCancelledError,
  JobFailureError,
  JobRetryableError,
  type CompositionModel,
  type JobExecutionContext,
  type ProjectRef,
  type Result,
  type SynthesizedCue,
  type SynthesizeNarrationDependencies,
  type TtsSynthesisOptions,
  type TtsSynthesisRequest,
  type WriteEnvelope,
} from "@vidcom/core";
import { createTtsJobType } from "@vidcom/worker";

import { createFixedClock } from "../support/deterministic";

const PROJECT_ID = "demo" as ProjectId;
const REF = { id: PROJECT_ID, slug: "demo", root: "/w/demo" } as ProjectRef;

const INPUT = {
  projectId: PROJECT_ID,
  sceneIds: ["intro", "outro"],
  providerId: "vieneu",
  voiceId: "vieneu-v3-doan-trang",
};

function narratedScene(id: string) {
  return {
    id,
    src: null,
    start: 0,
    duration: 5,
    trackIndex: 0,
    block: null,
    isTransition: false,
    media: [],
    script: [],
    narration: {
      sceneId: id,
      text: "Xin chào",
      voice: "af_heart",
      status: "mock" as const,
      audioPath: `narration/${id}.wav`,
      command: "",
      revision: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      staleSince: null,
    },
    elements: [],
    unresolvedEffects: 0,
  };
}

function dependencies(
  synthesize: (cueCount: number, report: (done: number, total: number) => void) =>
    Result<readonly SynthesizedCue[], DomainError>,
): SynthesizeNarrationDependencies {
  return {
    workspace: {
      readProjectRef: async () => REF,
      resolve: async (_ref: unknown, path: string) => ok({ relative: path, absolute: `/w/demo/${path}` }),
      readHash: async () => null,
    },
    composition: {
      parseProject: async (): Promise<CompositionModel> => ({
        project: {} as CompositionModel["project"],
        scenes: [narratedScene("intro"), narratedScene("outro")],
        rootTrack: null,
        diagnostics: [],
        sources: [],
        references: [],
      }),
    },
    journal: {},
    authority: {
      mutateSource: async (): Promise<Result<WriteEnvelope, DomainError>> => ok({
        projectRevision: 7, entityRevision: null, fileHashes: {}, diagnostics: [],
      } as WriteEnvelope),
    },
    clock: createFixedClock("2026-08-03T00:00:00.000Z"),
    tts: {
      listProviders: async () => [],
      synthesize: async (request: TtsSynthesisRequest, options?: TtsSynthesisOptions) => synthesize(
        request.cues.length,
        (done, total) => options?.onCueDone?.(done, total),
      ),
    },
  } as unknown as SynthesizeNarrationDependencies;
}

function fakeContext(options: { cancelAfterReads?: number; progressFails?: boolean } = {}) {
  const progress: Array<{ progress: number; stage: string | null }> = [];
  let reads = 0;
  // Cancellation arrives while the job is already running, which is the only
  // case that matters: a job cancelled before it starts never calls an engine.
  const cancelled = () => options.cancelAfterReads !== undefined && reads++ >= options.cancelAfterReads;
  const context = {
    job: {} as JobExecutionContext["job"],
    signal: new AbortController().signal,
    async updateProgress(value: number, stage: string | null) {
      if (options.progressFails) throw new Error("job store is unavailable");
      progress.push({ progress: value, stage });
    },
    async heartbeat() {},
    // The scheduler records cancellation here and does NOT abort the signal, so
    // this is the only channel a running job has to learn about it.
    async isCancellationRequested() { return cancelled(); },
    async throwIfCancelled() { if (cancelled()) throw new JobCancelledError(); },
  } satisfies JobExecutionContext;
  return { context, progress };
}

function succeeds(cueCount: number, report: (done: number, total: number) => void) {
  for (let index = 1; index <= cueCount; index += 1) report(index, cueCount);
  return ok(["intro", "outro"].slice(0, cueCount).map((cueId) => ({
    cueId,
    audio: new Uint8Array([1]),
    durationSeconds: 2,
    words: [],
    metadata: {},
  })));
}

describe("tts job type", () => {
  it("is capped at one concurrent batch, because a local model does not share a laptop", () => {
    const definition = createTtsJobType({ dependencies: dependencies(succeeds), actor: "user" });

    expect(definition).toMatchObject({ type: "tts", concurrency: 1 });
  });

  it("is neither idempotent nor retried, because synthesis costs money and is not reproducible", () => {
    const definition = createTtsJobType({ dependencies: dependencies(succeeds), actor: "user" });

    // A requeue after a crash would charge the account a second time and commit
    // a second revision of audio the user asked for once.
    expect(definition.idempotent).toBe(false);
    expect(definition.maxAttempts).toBe(1);
  });

  it("returns the published assets and revision", async () => {
    const definition = createTtsJobType({ dependencies: dependencies(succeeds), actor: "user" });
    const { context } = fakeContext();

    const result = await definition.run(INPUT, context);

    expect(result).toMatchObject({
      revision: 7,
      assets: [
        { sceneId: "intro", path: "narration/intro.wav", durationSeconds: 2 },
        { sceneId: "outro", path: "narration/outro.wav", durationSeconds: 2 },
      ],
    });
  });

  it("reports per-cue progress but never reaches 1 before the write lands", async () => {
    const definition = createTtsJobType({ dependencies: dependencies(succeeds), actor: "user" });
    const { context, progress } = fakeContext();

    await definition.run(INPUT, context);
    await Promise.resolve();

    // Progress at 100% while the job keeps running reads as a hang.
    const duringSynthesis = progress.filter((entry) => entry.stage?.startsWith("voiced"));
    expect(duringSynthesis.every((entry) => entry.progress < 1)).toBe(true);
    expect(progress.at(-1)).toEqual({ progress: 1, stage: null });
  });

  it.each([
    [ErrorCode.TtsQuotaExceeded, "rate limited"],
    [ErrorCode.TtsCredentialMissing, "no key"],
    [ErrorCode.TtsVoiceNotSupported, "wrong voice"],
  ])("surfaces %s to the job record instead of collapsing it to internal", async (code, message) => {
    const definition = createTtsJobType({
      dependencies: dependencies(() => err({ code, message })),
      actor: "user",
    });
    const { context } = fakeContext();

    const failure = await definition.run(INPUT, context).catch((error: unknown) => error);
    // Without the code the UI cannot tell "add an API key" from "out of quota"
    // from "that voice does not exist" — the three a user can actually fix.
    expect(failure).toBeInstanceOf(JobFailureError);
    expect((failure as JobFailureError).error).toMatchObject({ code, message });
  });

  it("never asks to be retried, whatever failed", async () => {
    const definition = createTtsJobType({
      dependencies: dependencies(() => err({ code: ErrorCode.TtsQuotaExceeded, message: "rate limited" })),
      actor: "user",
    });
    const { context } = fakeContext();

    const failure = await definition.run(INPUT, context).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(JobRetryableError);
  });

  it("stops the engine and publishes nothing once the job is cancelled", async () => {
    let observedSignal: AbortSignal | undefined;
    const dependenciesUnderTest = dependencies((cueCount, report) => {
      report(1, cueCount);
      return ok([]);
    });
    const seen: string[] = [];
    const definition = createTtsJobType({
      dependencies: {
        ...dependenciesUnderTest,
        tts: {
          listProviders: async () => [],
          synthesize: async (_request: TtsSynthesisRequest, options?: TtsSynthesisOptions) => {
            observedSignal = options?.signal;
            // Runs long enough for the cancellation poll to fire, the way a real
            // subprocess or HTTP call would.
            await new Promise<void>((resolve) => setTimeout(resolve, 60));
            options?.signal?.throwIfAborted();
            seen.push("synthesized");
            return ok([]);
          },
        },
        authority: {
          mutateSource: async () => {
            seen.push("published");
            return ok({ projectRevision: 1, entityRevision: null, fileHashes: {}, diagnostics: [] } as WriteEnvelope);
          },
        },
      } as unknown as SynthesizeNarrationDependencies,
      actor: "user",
      cancellationPollMs: 10,
    });
    // The first read is the job's own pre-flight check; cancellation lands on
    // the next one, once the engine is already running.
    const { context } = fakeContext({ cancelAfterReads: 1 });

    const failure = await definition.run(INPUT, context).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JobCancelledError);
    expect(observedSignal?.aborted).toBe(true);
    expect(seen).toEqual([]);
  });

  it("survives a progress write that fails, because progress is cosmetic and the job is not", async () => {
    const warnings: string[] = [];
    const definition = createTtsJobType({
      dependencies: dependencies(succeeds),
      actor: "user",
      log: { warn: (message) => warnings.push(message), error: () => {} },
    });
    const { context } = fakeContext({ progressFails: true });

    // `void updateProgress(...)` on its own made a SQLite outage an unhandled
    // rejection, which under Node's default policy kills the whole daemon.
    await expect(definition.run(INPUT, context)).resolves.toMatchObject({ revision: 7 });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects input that does not match the job schema", async () => {
    const definition = createTtsJobType({ dependencies: dependencies(succeeds), actor: "user" });
    const { context } = fakeContext();

    await expect(definition.run({ sceneIds: [] }, context)).rejects.toBeInstanceOf(TypeError);
  });
});
