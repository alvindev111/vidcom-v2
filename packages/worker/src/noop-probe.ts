import type { JobExecutionContext, JobTypeDefinition } from "@vidcom/core";

export interface NoopProbeInput {
  steps: number;
  delayMs: number;
  failAtStep?: number;
}

export interface NoopProbeOutput {
  completedSteps: number;
}

function parseInput(input: unknown): NoopProbeInput {
  if (!input || typeof input !== "object") throw new TypeError("noop-probe input must be an object");
  const value = input as Record<string, unknown>;
  if (!Number.isInteger(value.steps) || (value.steps as number) < 1) {
    throw new TypeError("noop-probe steps must be a positive integer");
  }
  if (!Number.isInteger(value.delayMs) || (value.delayMs as number) < 0) {
    throw new TypeError("noop-probe delayMs must be a non-negative integer");
  }
  if (value.failAtStep !== undefined && (
    !Number.isInteger(value.failAtStep)
    || (value.failAtStep as number) < 1
    || (value.failAtStep as number) > (value.steps as number)
  )) throw new TypeError("noop-probe failAtStep must identify an existing step");
  return value as unknown as NoopProbeInput;
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/** Deterministic, filesystem-free job type used to prove scheduler lifecycle behavior. */
export function createNoopProbeJobType(options: {
  concurrency?: number;
  sleep?: (delayMs: number) => Promise<void>;
} = {}): JobTypeDefinition {
  const wait = options.sleep ?? sleep;
  return {
    type: "noop-probe",
    concurrency: options.concurrency ?? 2,
    idempotent: true,
    async run(rawInput: unknown, context: JobExecutionContext): Promise<NoopProbeOutput> {
      const input = parseInput(rawInput);
      for (let step = 1; step <= input.steps; step += 1) {
        await context.throwIfCancelled();
        await wait(input.delayMs);
        if (input.failAtStep === step) throw new Error(`noop-probe failed at step ${step}`);
        await context.updateProgress(step / input.steps, `step ${step}/${input.steps}`);
      }
      return { completedSteps: input.steps };
    },
  };
}
