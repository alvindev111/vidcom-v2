import {
  DEFAULT_TTS_COMPUTE_DEVICE,
  TtsJobInputSchema,
  type Actor,
  type ProjectId,
  type TtsJobResultDto,
} from "@vidcom/contracts";
import {
  JobCancelledError,
  JobFailureError,
  synthesizeNarration,
  type JobExecutionContext,
  type JobTypeDefinition,
  type LogPort,
  type SynthesizeNarrationDependencies,
} from "@vidcom/core";

/** The job's own ceiling; the VieNeu sidecar has a shorter one for the model download inside it. */
const TIMEOUT_MS = 25 * 60 * 1_000;

/**
 * How often the running job asks whether it has been cancelled.
 *
 * The scheduler records cancellation in the database but does not abort the
 * job's signal, so nothing stops a running batch unless the job polls. Two
 * seconds is short enough that a user pressing cancel sees the subprocess die
 * promptly, and long enough that a 50-cue batch adds a negligible number of
 * reads.
 */
const CANCELLATION_POLL_MS = 2_000;

export interface TtsJobOptions {
  dependencies: SynthesizeNarrationDependencies;
  /** Who the resulting write is attributed to; the enqueuing transport decides. */
  actor: Actor;
  /** Optional sink for progress-write failures, which must never kill the job. */
  log?: LogPort;
  /** Test seam for the cancellation poll interval. */
  cancellationPollMs?: number;
}

/**
 * The `tts` job: turns a scene's narration text into audio and publishes it.
 *
 * Concurrency is one, deliberately. VieNeu loads its model per batch and this
 * runs on a user's laptop rather than a server — a second concurrent batch does
 * not halve the wall clock, it swaps.
 *
 * **Not idempotent, and not retried.** Synthesis bills a cloud account and its
 * output is not byte-deterministic, so a requeue after a crash would charge the
 * user twice and commit a second revision of audio they asked for once. The
 * same reasoning rules out retrying a partly-finished batch: one late transient
 * failure in a 50-scene batch would re-issue and re-bill the 49 calls that had
 * already succeeded. A failed TTS job stays failed and the user decides whether
 * to spend again.
 */
export function createTtsJobType(options: TtsJobOptions): JobTypeDefinition {
  return {
    type: "tts",
    concurrency: 1,
    idempotent: false,
    timeoutMs: TIMEOUT_MS,
    maxAttempts: 1,
    async run(rawInput: unknown, context: JobExecutionContext): Promise<TtsJobResultDto> {
      const parsed = TtsJobInputSchema.safeParse(rawInput);
      if (!parsed.success) throw new TypeError("tts job input does not match its schema");
      const input = parsed.data;

      // The scheduler's own signal only fires on timeout. This one also fires
      // when the user cancels, which is what actually kills the ElevenLabs
      // request or the Python process tree mid-batch.
      const controller = new AbortController();
      const abortOnSchedulerSignal = () => controller.abort();
      context.signal.addEventListener("abort", abortOnSchedulerSignal, { once: true });
      const poll = setInterval(() => {
        void context.isCancellationRequested()
          .then((cancelled) => { if (cancelled) controller.abort(); })
          .catch(() => { /* a failed read is retried on the next tick */ });
      }, options.cancellationPollMs ?? CANCELLATION_POLL_MS);

      try {
        await context.throwIfCancelled();
        await report(options, context, 0, `preparing ${input.sceneIds.length} scene(s)`);
        const result = await synthesizeNarration(options.dependencies, {
          projectId: input.projectId as ProjectId,
          sceneIds: input.sceneIds,
          providerId: input.providerId,
          voiceId: input.voiceId,
          modelId: input.modelId ?? null,
          ratePercent: input.ratePercent ?? 0,
          computeDevice: input.computeDevice ?? DEFAULT_TTS_COMPUTE_DEVICE,
        }, options.actor, {
          signal: controller.signal,
          onCueDone: (done, total) => {
            // Capped below 1: publishing the audio is still ahead, and progress
            // that reaches 100% while the job keeps running reads as a hang.
            void report(options, context, Math.min(0.9, done / total), `voiced ${done}/${total}`);
          },
        });
        if (!result.ok) {
          // Carries the domain code, so `GET /jobs/:id` can say "add an API key"
          // rather than "internal".
          throw new JobFailureError(result.error);
        }
        await report(options, context, 1, null);
        return result.value;
      } catch (error) {
        // A cancelled batch may have aborted mid-write; the scheduler needs the
        // cancellation, not the AbortError the provider happened to surface.
        if (controller.signal.aborted && await context.isCancellationRequested()) {
          throw new JobCancelledError();
        }
        throw error;
      } finally {
        clearInterval(poll);
        context.signal.removeEventListener("abort", abortOnSchedulerSignal);
      }
    },
  };
}

/**
 * Records progress without letting a storage failure kill the run.
 *
 * `void context.updateProgress(...)` on its own was an unhandled rejection
 * waiting to happen: SQLite going away during a long batch would take down the
 * whole daemon under Node's default rejection policy, mid-synthesis, leaving the
 * subprocess and scratch directory behind. Progress is cosmetic; the job is not.
 */
async function report(
  options: TtsJobOptions,
  context: JobExecutionContext,
  progress: number,
  stage: string | null,
): Promise<void> {
  try {
    await context.updateProgress(progress, stage);
  } catch (error) {
    options.log?.warn("tts job progress could not be recorded", {
      stage,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
