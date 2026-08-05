import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateDatabase, nodeSchedulerTimers, openVidcomDatabase, SqliteJobStore } from "@vidcom/adapter";
import { ErrorCode, WarningCode, type ContentHash, type ProjectId } from "@vidcom/contracts";
import {
  canonicalizeJobInput,
  JobCancelledError,
  JobFailureError,
  JobScheduler,
  JobRetryableError,
  type JobExecutionContext,
  type JobId,
  type JobTypeDefinition,
} from "@vidcom/core";
import { createNoopProbeJobType } from "@vidcom/worker";
import { afterEach, describe, expect, it } from "vitest";

import { createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbRun } from "../support/database";

const roots: string[] = [];
const p1 = "project_one" as ProjectId;
const p2 = "project_two" as ProjectId;

function mutableClock(initial: string) {
  let timestamp = new Date(initial).getTime();
  return {
    now: () => new Date(timestamp),
    advance(ms: number) { timestamp += ms; },
  };
}

function inputHash(input: unknown): ContentHash {
  return `sha256:${createHash("sha256").update(canonicalizeJobInput(input)).digest("hex")}` as ContentHash;
}

async function fixture(now = "2026-08-01T00:00:00.000Z") {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-jobs-"));
  roots.push(root);
  const database = openVidcomDatabase(root);
  await migrateDatabase(database);
  for (const [id, slug] of [[p1, "one"], [p2, "two"]] as const) {
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    id, "/workspace", slug, now, now);
  }
  const clock = mutableClock(now);
  return { root, database, clock, store: new SqliteJobStore(database, clock) };
}

function newJob(
  id: string,
  projectId: ProjectId,
  input: unknown,
  key: string | null = null,
  type = "noop-probe",
) {
  return {
    id: id as JobId,
    projectId,
    type,
    input,
    inputHash: inputHash(input),
    idempotencyKey: key,
  };
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("SQLite job infrastructure", () => {
  it("canonicalizes input and implements all three idempotency cases", async () => {
    const { database, store } = await fixture();
    try {
      expect(canonicalizeJobInput({ z: -0, a: { y: 2, x: 1 } }))
        .toBe('{"a":{"x":1,"y":2},"z":0}');
      const first = await store.enqueue(newJob("job_first", p1, { steps: 2, delayMs: 0 }, "same"));
      expect(first).toMatchObject({ reused: false });
      const retry = await store.enqueue(newJob("job_retry", p1, { delayMs: 0, steps: 2 }, "same"));
      expect(retry).toMatchObject({ reused: true, job: { id: "job_first" } });
      await expect(store.enqueue(newJob("job_conflict", p1, { steps: 3, delayMs: 0 }, "same")))
        .resolves.toEqual({ conflict: "idempotency_key_reused" });
      await expect(store.enqueue(newJob("job_other", p2, { steps: 3, delayMs: 0 }, "same")))
        .resolves.toMatchObject({ reused: false, job: { id: "job_other" } });
      expect(dbAll(database, "SELECT id FROM job")).toHaveLength(2);
    } finally {
      await database.destroy();
    }
  });

  it("claims once, keeps progress monotonic, and makes terminal operations no-ops", async () => {
    const { database, store } = await fixture();
    try {
      await store.enqueue(newJob("job_claim", p1, { steps: 1, delayMs: 0 }));
      expect((await Promise.all([
        store.claim("job_claim" as JobId, "worker_a"),
        store.claim("job_claim" as JobId, "worker_b"),
      ])).filter(Boolean)).toHaveLength(1);
      await store.updateProgress("job_claim" as JobId, 0.7, "later");
      await store.updateProgress("job_claim" as JobId, 0.7, "same-progress-new-stage");
      await store.updateProgress("job_claim" as JobId, 0.4, "earlier");
      expect(await store.finish("job_claim" as JobId, { status: "succeeded", result: { ok: true } })).toBe(true);
      await store.requestCancel("job_claim" as JobId);
      expect(await store.finish("job_claim" as JobId, {
        status: "failed", error: { code: ErrorCode.Internal, message: "too late" },
      })).toBe(false);
      expect(await store.get("job_claim" as JobId)).toMatchObject({
        status: "succeeded", progress: 1, stage: "same-progress-new-stage", result: { ok: true }, attempt: 1,
      });
    } finally {
      await database.destroy();
    }
  });

  it("persists a partial result, terminal progress, warnings, and cleanup metadata", async () => {
    const { database, store } = await fixture();
    try {
      await store.enqueue(newJob("job_partial", p1, {}));
      await store.claim("job_partial" as JobId, "worker_partial");
      await store.updateProgress("job_partial" as JobId, 0.4, "rendering");
      expect(await store.finish("job_partial" as JobId, {
        status: "partial",
        result: { missingSceneIds: ["scene_2"] },
        warnings: [{ code: WarningCode.TerminationProofNotExhaustive, message: "bounded proof" }],
        cleanupPending: true,
      })).toBe(true);
      expect(await store.get("job_partial" as JobId)).toMatchObject({
        status: "partial",
        progress: 1,
        result: { missingSceneIds: ["scene_2"] },
        warnings: [{ code: "termination_proof_not_exhaustive", message: "bounded proof" }],
        cleanupPending: true,
      });
    } finally {
      await database.destroy();
    }
  });

  it("enforces per-type concurrency and serializes the same project/type pair", async () => {
    const { database, store, clock } = await fixture();
    let active = 0;
    let maximum = 0;
    const pairs = new Set<string>();
    let samePairOverlap = false;
    const definition: JobTypeDefinition = {
      type: "noop-probe", concurrency: 2, idempotent: true,
      async run(_input: unknown, context: JobExecutionContext) {
        const pair = `${context.job.projectId}:${context.job.type}`;
        if (pairs.has(pair)) samePairOverlap = true;
        pairs.add(pair); active += 1; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        clock.advance(250);
        await context.updateProgress(0.5, "half");
        active -= 1; pairs.delete(pair);
        return { ok: true };
      },
    };
    try {
      for (const [id, project] of [["job_1", p1], ["job_2", p1], ["job_3", p2], ["job_4", p2]] as const) {
        await store.enqueue(newJob(id, project, { id }));
      }
      const scheduler = new JobScheduler(store, clock, createSequentialIdPort(), [definition], undefined, nodeSchedulerTimers);
      await scheduler.runAvailable();
      await scheduler.waitForIdle();
      expect(maximum).toBe(2);
      expect(samePairOverlap).toBe(false);
      expect(dbAll<{ status: string }>(database, "SELECT status FROM job").every((row) => row.status === "succeeded"))
        .toBe(true);
    } finally {
      await database.destroy();
    }
  });

  it("keeps stage-only scheduler updates and persists retrying before emitting it", async () => {
    const { database, store, clock } = await fixture();
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let runs = 0;
    const definition: JobTypeDefinition = {
      type: "noop-probe", concurrency: 1, idempotent: true, maxAttempts: 2, retryBaseDelayMs: 0,
      async run(_input, context) {
        runs += 1;
        await context.updateProgress(0, runs === 1 ? "started" : "resumed");
        if (runs === 1) throw new JobRetryableError("transient");
        return { ok: true };
      },
    };
    try {
      await store.enqueue(newJob("job_stage", p1, {}));
      const scheduler = new JobScheduler(store, clock, createSequentialIdPort(), [definition], {
        async append(event) { emitted.push(event as typeof emitted[number]); return emitted.length; },
        async readFrom() { return { events: [], gap: false }; },
        async latestSeq() { return 0; },
      }, nodeSchedulerTimers);
      await scheduler.runAvailable();
      await scheduler.waitForIdle();
      expect(await store.get("job_stage" as JobId)).toMatchObject({
        status: "succeeded", stage: "resumed", attempt: 2,
      });
      expect(emitted).toContainEqual(expect.objectContaining({
        type: "job.progress", payload: expect.objectContaining({ stage: "retrying" }),
      }));
    } finally {
      await database.destroy();
    }
  });

  it("times out work and bounds transient retries with exponential-delay configuration", async () => {
    const { database, store, clock } = await fixture();
    const definition: JobTypeDefinition = {
      type: "noop-probe",
      concurrency: 1,
      idempotent: true,
      timeoutMs: 5,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
      terminationGraceMs: 100,
      async run(_input, context) {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            setTimeout(() => reject(new JobRetryableError("abort cleanup finished")), 20);
          }, { once: true });
        });
      },
    };
    try {
      await store.enqueue(newJob("job_timeout", p1, {}));
      const scheduler = new JobScheduler(store, clock, createSequentialIdPort(), [definition], undefined, nodeSchedulerTimers);
      await scheduler.runAvailable();
      await scheduler.waitForIdle();
      expect(await store.get("job_timeout" as JobId)).toMatchObject({
        status: "failed",
        attempt: 2,
        error: { message: "job timed out after 5ms" },
      });
    } finally {
      await database.destroy();
    }
  });

  it("polls durable cancellation during a running handler without entering timeout retry", async () => {
    const { database, store, clock } = await fixture();
    let runs = 0;
    const definition: JobTypeDefinition = {
      type: "noop-probe", concurrency: 1, idempotent: true, maxAttempts: 3, timeoutMs: 10_000,
      async run(_input, context) {
        runs += 1;
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new JobCancelledError([
            { code: WarningCode.TerminationProofNotExhaustive, message: "bounded termination proof" },
          ], true)), { once: true });
        });
      },
    };
    try {
      await store.enqueue(newJob("job_poll_cancel", p1, {}));
      const scheduler = new JobScheduler(store, clock, createSequentialIdPort(), [definition], undefined, nodeSchedulerTimers);
      await scheduler.runAvailable();
      while ((await store.get("job_poll_cancel" as JobId))?.status !== "running") {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await store.requestCancel("job_poll_cancel" as JobId);
      await scheduler.waitForIdle();
      expect(await store.get("job_poll_cancel" as JobId)).toMatchObject({
        status: "cancelled",
        attempt: 1,
        warnings: [{ code: WarningCode.TerminationProofNotExhaustive }],
        cleanupPending: true,
      });
      expect(runs).toBe(1);
    } finally {
      await database.destroy();
    }
  });

  it("persists process termination failure instead of cancelled when a cancel proof has survivors", async () => {
    const { database, store, clock } = await fixture();
    const definition: JobTypeDefinition = {
      type: "noop-probe", concurrency: 1, idempotent: false, timeoutMs: 10_000,
      async run(_input, context) {
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new JobFailureError({
            code: ErrorCode.ProcessTerminationUnverified,
            message: "survivor pid 42",
          })), { once: true });
        });
      },
    };
    try {
      await store.enqueue(newJob("job_unverified_cancel", p1, {}));
      const scheduler = new JobScheduler(store, clock, createSequentialIdPort(), [definition], undefined, nodeSchedulerTimers);
      await scheduler.runAvailable();
      while ((await store.get("job_unverified_cancel" as JobId))?.status !== "running") {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await store.requestCancel("job_unverified_cancel" as JobId);
      await scheduler.waitForIdle();
      expect(await store.get("job_unverified_cancel" as JobId)).toMatchObject({
        status: "failed",
        error: { code: ErrorCode.ProcessTerminationUnverified, message: "survivor pid 42" },
      });
    } finally {
      await database.destroy();
    }
  });

  it("keeps the cancel/complete barrier atomic with respect to artifact publish", async () => {
    const { database, store, clock, root } = await fixture();
    const artifact = path.join(root, "published.txt");
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const definition: JobTypeDefinition = {
      type: "barrier", concurrency: 1, idempotent: false,
      async run(_input, context) {
        await context.beginPublication();
        entered();
        await barrier;
        await writeFile(artifact, "published", "utf8");
        return { artifact };
      },
    };
    try {
      await store.enqueue(newJob("job_barrier", p1, {}, null, "barrier"));
      const scheduler = new JobScheduler(store, clock, createSequentialIdPort(), [definition], undefined, nodeSchedulerTimers);
      await scheduler.runAvailable();
      await started;
      await store.requestCancel("job_barrier" as JobId);
      release();
      await scheduler.waitForIdle();
      await expect(access(artifact)).resolves.toBeUndefined();
      expect(await store.get("job_barrier" as JobId)).toMatchObject({ status: "succeeded", cancelRequested: false });

      expect(await store.finish("job_barrier" as JobId, { status: "succeeded", result: {} })).toBe(false);
      await store.requestCancel("job_barrier" as JobId);
      expect(await store.get("job_barrier" as JobId)).toMatchObject({ status: "succeeded", cancelRequested: false });
    } finally {
      await database.destroy();
    }
  });

  it("cancels at a noop-probe safe point and records worker failures", async () => {
    const { database, store, clock } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const firstWait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let waits = 0;
    const probe = createNoopProbeJobType({
      concurrency: 1,
      sleep: async () => { waits += 1; entered(); await firstWait; clock.advance(250); },
    });
    const cleaned: string[] = [];
    const definition: JobTypeDefinition = {
      ...probe,
      async cleanup(job) { cleaned.push(job.id); },
    };
    try {
      await store.enqueue(newJob("job_cancel", p1, { steps: 2, delayMs: 1 }));
      await store.enqueue(newJob("job_fail", p2, { steps: 1, delayMs: 0, failAtStep: 1 }));
      const scheduler = new JobScheduler(store, clock, createSequentialIdPort(), [definition], undefined, nodeSchedulerTimers);
      await scheduler.runAvailable();
      await started;
      await store.requestCancel("job_cancel" as JobId);
      release();
      await scheduler.waitForIdle();
      expect(waits).toBe(2);
      expect(await store.get("job_cancel" as JobId)).toMatchObject({ status: "cancelled", progress: 0.5 });
      expect(await store.get("job_fail" as JobId)).toMatchObject({
        status: "failed", attempt: 1,
        error: { code: ErrorCode.Internal, message: "noop-probe failed at step 1" },
      });
      expect(cleaned).toContain("job_cancel");
    } finally {
      await database.destroy();
    }
  });

  it("survives a daemon-style database close and recovers stale work by type policy", async () => {
    const first = await fixture();
    await first.store.enqueue(newJob("job_restart", p1, { steps: 1, delayMs: 0 }));
    await first.store.enqueue(newJob("job_one_shot", p2, { once: true }, null, "one-shot"));
    await first.store.claim("job_restart" as JobId, "killed_worker");
    await first.store.claim("job_one_shot" as JobId, "killed_worker");
    const root = first.root;
    await first.database.destroy();

    const database = openVidcomDatabase(root);
    const clock = mutableClock("2026-08-01T00:01:00.000Z");
    const store = new SqliteJobStore(database, clock);
    try {
      const scheduler = new JobScheduler(
        store, clock, createSequentialIdPort(), [
          createNoopProbeJobType({ sleep: async () => {} }),
          {
            type: "one-shot",
            concurrency: 1,
            idempotent: false,
            cleanupPendingOnStale: true,
            async run() { return {}; },
          },
        ],
        undefined,
        nodeSchedulerTimers,
      );
      await scheduler.recoverStale();
      expect(await store.get("job_restart" as JobId)).toMatchObject({ status: "queued", attempt: 1 });
      expect(await store.get("job_one_shot" as JobId)).toMatchObject({
        status: "failed",
        error: { message: "job worker stopped before completion" },
        cleanupPending: true,
      });
      await scheduler.runAvailable();
      await scheduler.waitForIdle();
      expect(await store.get("job_restart" as JobId)).toMatchObject({
        status: "succeeded", attempt: 2, result: { completedSteps: 1 },
      });
    } finally {
      await database.destroy();
    }
  });
});
