import { ErrorCode, type DomainError, type JobWarningDto } from "@vidcom/contracts";

import type { ClockPort, EventOutboxPort, IdPort, JobStorePort } from "../port/ports";
import type { Job, JobId } from "../port/types";
import type { ProcessTerminationProof } from "../port/process-port";

export const CANCELLATION_POLL_MS = 250;

export interface JobExecutionContext {
  job: Job;
  signal: AbortSignal;
  updateProgress(progress: number, stage: string | null): Promise<void>;
  heartbeat(): Promise<void>;
  isCancellationRequested(): Promise<boolean>;
  throwIfCancelled(): Promise<void>;
}

export interface JobTypeDefinition {
  type: string;
  concurrency: number;
  idempotent: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  cleanupPendingOnStale?: boolean;
  run(input: unknown, context: JobExecutionContext): Promise<unknown>;
  cleanup?(job: Job): Promise<void>;
}

const JOB_EXECUTION_OUTCOME = Symbol("vidcom.job-execution-outcome");

/** Branded terminal result for handlers that need partial status or job metadata. */
export interface JobExecutionOutcome {
  readonly [JOB_EXECUTION_OUTCOME]: true;
  readonly outcome: Extract<import("../port/types").JobOutcome, { status: "succeeded" | "partial" }>;
}

/** Wraps a successful/partial handler outcome without confusing ordinary result objects. */
export function jobExecutionOutcome(outcome: JobExecutionOutcome["outcome"]): JobExecutionOutcome {
  return { [JOB_EXECUTION_OUTCOME]: true, outcome };
}

function isJobExecutionOutcome(value: unknown): value is JobExecutionOutcome {
  return typeof value === "object" && value !== null
    && (value as Partial<JobExecutionOutcome>)[JOB_EXECUTION_OUTCOME] === true;
}

export interface SchedulerTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class JobCancelledError extends Error {
  constructor(
    readonly warnings: readonly JobWarningDto[] = [],
    readonly cleanupPending = false,
    readonly terminationProof?: ProcessTerminationProof,
  ) {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}

/** Explicit marker for transient failures that an idempotent job may retry. */
export class JobRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobRetryableError";
  }
}

/**
 * Job failure that carries the domain error the client should actually see.
 *
 * Without it every failure is persisted as `internal`, and a UI reading
 * `GET /jobs/:id` cannot tell "add an API key" from "out of quota" from "that
 * voice does not exist" — the three things a user is most likely to be able to
 * fix themselves.
 */
export class JobFailureError extends Error {
  readonly warnings: readonly JobWarningDto[];
  readonly cleanupPending: boolean;
  readonly terminationProof: ProcessTerminationProof | undefined;

  constructor(
    readonly error: DomainError,
    options?: ErrorOptions & {
      warnings?: readonly JobWarningDto[];
      cleanupPending?: boolean;
      terminationProof?: ProcessTerminationProof;
    },
  ) {
    super(error.message, options);
    this.name = "JobFailureError";
    this.warnings = options?.warnings ?? [];
    this.cleanupPending = options?.cleanupPending ?? false;
    this.terminationProof = options?.terminationProof;
  }
}

/** In-process scheduler enforcing per-type and per-project/type concurrency. */
export class JobScheduler {
  private readonly definitions = new Map<string, JobTypeDefinition>();
  private readonly active = new Map<JobId, Promise<void>>();
  private readonly activeCounts = new Map<string, number>();
  private readonly activePairs = new Map<string, { projectId: Job["projectId"]; type: string }>();
  private scheduling = false;
  private scheduleAgain = false;
  private polling: unknown | null = null;

  constructor(
    private readonly store: JobStorePort,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
    definitions: readonly JobTypeDefinition[],
    private readonly events: EventOutboxPort | undefined,
    private readonly timers: SchedulerTimers,
  ) {
    for (const definition of definitions) {
      if (!Number.isInteger(definition.concurrency) || definition.concurrency < 1) {
        throw new TypeError(`job type ${definition.type} must have positive integer concurrency`);
      }
      if (this.definitions.has(definition.type)) throw new TypeError(`duplicate job type ${definition.type}`);
      this.definitions.set(definition.type, definition);
    }
  }

  async runAvailable(): Promise<void> {
    if (this.scheduling) {
      this.scheduleAgain = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.scheduleAgain = false;
        while (true) {
          const eligibleTypes = [...this.definitions.values()]
            .filter((definition) => (this.activeCounts.get(definition.type) ?? 0) < definition.concurrency)
            .map((definition) => definition.type);
          const job = await this.store.nextQueued(eligibleTypes, [...this.activePairs.values()]);
          if (!job) break;
          const workerId = this.ids.newId("worker");
          if (!(await this.store.claim(job.id as JobId, workerId))) continue;
          const claimed = await this.store.get(job.id as JobId);
          if (!claimed) continue;
          this.begin(claimed);
        }
      } while (this.scheduleAgain);
    } finally {
      this.scheduling = false;
    }
  }

  start(pollMs = 250): void {
    if (this.polling !== null) return;
    void this.runAvailable();
    this.polling = this.timers.setInterval(() => void this.runAvailable(), pollMs);
  }

  async stop(): Promise<void> {
    if (this.polling !== null) this.timers.clearInterval(this.polling);
    this.polling = null;
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()]);
  }

  async recoverStale(staleAfterMs = 30_000): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - staleAfterMs);
    for (const job of await this.store.listStale(cutoff)) {
      if (job.cancelRequested) {
        await this.store.finish(job.id as JobId, {
          status: "cancelled",
          cleanupPending: this.definitions.get(job.type)?.cleanupPendingOnStale === true,
        });
      } else if (this.definitions.get(job.type)?.idempotent) {
        await this.store.requeue(job.id as JobId);
      } else {
        await this.store.finish(job.id as JobId, {
          status: "failed",
          error: { code: ErrorCode.Internal, message: "job worker stopped before completion" },
          cleanupPending: this.definitions.get(job.type)?.cleanupPendingOnStale === true,
        });
      }
    }
  }

  activeCount(type: string): number {
    return this.activeCounts.get(type) ?? 0;
  }

  private begin(job: Job): void {
    const pairKey = `${job.projectId}\u0000${job.type}`;
    this.activeCounts.set(job.type, (this.activeCounts.get(job.type) ?? 0) + 1);
    this.activePairs.set(pairKey, { projectId: job.projectId, type: job.type });
    const execution = this.execute(job).finally(async () => {
      this.active.delete(job.id as JobId);
      this.activePairs.delete(pairKey);
      this.activeCounts.set(job.type, (this.activeCounts.get(job.type) ?? 1) - 1);
      await this.runAvailable();
    });
    this.active.set(job.id as JobId, execution);
  }

  private async execute(job: Job): Promise<void> {
    const definition = this.definitions.get(job.type);
    if (!definition) return;
    const controller = new AbortController();
    let abortReason: "cancel" | "timeout" | null = null;
    let lastProgress = job.progress;
    let lastStage = job.stage;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    const context: JobExecutionContext = {
      job,
      signal: controller.signal,
      updateProgress: async (progress, stage) => {
        const bounded = Math.min(1, Math.max(0, progress));
        if (bounded < lastProgress || (bounded === lastProgress && stage === lastStage)) return;
        const now = this.clock.now().getTime();
        if (bounded > lastProgress && bounded < 1 && now - lastProgressAt < 250) return;
        lastProgress = bounded;
        lastStage = stage;
        lastProgressAt = now;
        await this.store.updateProgress(job.id as JobId, bounded, stage);
        const persisted = await this.store.get(job.id as JobId);
        await this.emit({
          type: "job.progress",
          projectId: job.projectId,
          payload: {
            jobId: job.id,
            progress: persisted?.progress ?? bounded,
            stage: persisted?.stage ?? stage,
            partial: persisted?.status === "partial",
          },
        });
      },
      heartbeat: () => this.store.heartbeat(job.id as JobId),
      isCancellationRequested: () => this.store.isCancellationRequested(job.id as JobId),
      throwIfCancelled: async () => {
        if (await this.store.isCancellationRequested(job.id as JobId)) throw new JobCancelledError();
      },
    };
    const heartbeat = this.timers.setInterval(() => void context.heartbeat(), 5_000);
    const cancellationPoll = this.timers.setInterval(() => {
      void context.isCancellationRequested().then((requested) => {
        if (!requested || abortReason !== null) return;
        abortReason = "cancel";
        controller.abort();
      });
    }, CANCELLATION_POLL_MS);
    const timeoutMs = definition.timeoutMs ?? 60_000;
    let timeout: unknown | null = null;
    try {
      await context.throwIfCancelled();
      const result = await Promise.race([
        definition.run(job.input, context),
        new Promise<never>((_resolve, reject) => {
          timeout = this.timers.setTimeout(() => {
            if (abortReason !== null) return;
            abortReason = "timeout";
            controller.abort();
            reject(new JobRetryableError(`job timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      await context.throwIfCancelled();
      const outcome = isJobExecutionOutcome(result)
        ? result.outcome
        : { status: "succeeded" as const, result };
      const applied = await this.store.finish(job.id as JobId, outcome);
      if (applied) await this.emit({
        type: "job.done", projectId: job.projectId,
        payload: { jobId: job.id, status: outcome.status, partial: outcome.status === "partial" },
      });
    } catch (error) {
      await definition.cleanup?.(job);
      const terminationUnverified = error instanceof JobFailureError
        && error.error.code === ErrorCode.ProcessTerminationUnverified;
      if (!terminationUnverified && (abortReason === "cancel" || error instanceof JobCancelledError)) {
        const cancelled = error instanceof JobCancelledError ? error : new JobCancelledError();
        const applied = await this.store.finish(job.id as JobId, {
          status: "cancelled",
          warnings: cancelled.warnings,
          cleanupPending: cancelled.cleanupPending,
          terminationProof: cancelled.terminationProof,
        });
        if (applied) await this.emit({
          type: "job.done", projectId: job.projectId,
          payload: { jobId: job.id, status: "cancelled", partial: false },
        });
      } else {
        if (definition.idempotent
          && error instanceof JobRetryableError
          && job.attempt < (definition.maxAttempts ?? 3)) {
          await this.store.updateProgress(job.id as JobId, lastProgress, "retrying");
          const baseDelay = Math.max(0, definition.retryBaseDelayMs ?? 1_000);
          const maxDelay = Math.max(baseDelay, definition.retryMaxDelayMs ?? 30_000);
          const delayMs = Math.min(maxDelay, baseDelay * (2 ** Math.max(0, job.attempt - 1)));
          await new Promise<void>((resolve) => this.timers.setTimeout(resolve, delayMs));
          await this.store.requeue(job.id as JobId);
          const persisted = await this.store.get(job.id as JobId);
          await this.emit({
            type: "job.progress",
            projectId: job.projectId,
            payload: {
              jobId: job.id,
              progress: persisted?.progress ?? lastProgress,
              stage: persisted?.stage ?? "retrying",
              partial: false,
            },
          });
          return;
        }
        await this.store.finish(job.id as JobId, {
          status: "failed",
          error: error instanceof JobFailureError
            ? { code: error.error.code, message: error.error.message }
            : {
                code: ErrorCode.Internal,
                message: error instanceof Error ? error.message : "job failed",
              },
          warnings: error instanceof JobFailureError ? error.warnings : undefined,
          cleanupPending: error instanceof JobFailureError ? error.cleanupPending : false,
          terminationProof: error instanceof JobFailureError ? error.terminationProof : undefined,
        });
        await this.emit({
          type: "job.done", projectId: job.projectId,
          payload: { jobId: job.id, status: "failed", partial: false },
        });
      }
    } finally {
      if (timeout !== null) this.timers.clearTimeout(timeout);
      this.timers.clearInterval(heartbeat);
      this.timers.clearInterval(cancellationPoll);
    }
  }

  private async emit(event: Parameters<EventOutboxPort["append"]>[0]): Promise<void> {
    if (!this.events) return;
    try { await this.events.append(event); } catch { /* persisted job state remains authoritative */ }
  }
}
