import { sql } from "drizzle-orm";

import type { ContentHash, ErrorCode, ProjectId } from "@vidcom/contracts";
import type { ClockPort, Job, JobId, JobOutcome, JobStorePort, NewJob } from "@vidcom/core";

import type { VidcomDatabase } from "./client";

interface JobRow {
  id: string;
  projectId: string | null;
  type: string;
  status: Job["status"];
  input: string;
  progress: number;
  stage: string | null;
  result: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempt: number;
  idempotencyKey: string | null;
  inputHash: string;
  cancelRequested: number;
  workerId: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const SELECT_JOB = sql.raw(`
  SELECT id, project_id AS projectId, type, status, input, progress, stage, result,
    error_code AS errorCode, error_message AS errorMessage, attempt,
    idempotency_key AS idempotencyKey, input_hash AS inputHash,
    cancel_requested AS cancelRequested, worker_id AS workerId,
    heartbeat_at AS heartbeatAt, created_at AS createdAt,
    started_at AS startedAt, finished_at AS finishedAt
  FROM job
`);

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value) as unknown;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    projectId: row.projectId as ProjectId,
    type: row.type,
    status: row.status,
    input: parseJson(row.input),
    inputHash: row.inputHash as ContentHash,
    idempotencyKey: row.idempotencyKey,
    progress: row.progress,
    stage: row.stage,
    result: parseJson(row.result),
    error: row.errorCode === null ? null : {
      code: row.errorCode as ErrorCode,
      message: row.errorMessage ?? "job failed",
    },
    attempt: row.attempt,
    cancelRequested: row.cancelRequested === 1,
    workerId: row.workerId,
    heartbeatAt: row.heartbeatAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Durable Drizzle job persistence with atomic claim and idempotent enqueue. */
export class SqliteJobStore implements JobStorePort {
  constructor(private readonly database: VidcomDatabase, private readonly clock: ClockPort) {}

  async enqueue(job: NewJob): Promise<{ job: Job; reused: boolean } | { conflict: "idempotency_key_reused" }> {
    if (job.idempotencyKey !== null) {
      const prior = this.findIdempotent(job);
      if (prior) return prior.inputHash === job.inputHash
        ? { job: prior, reused: true }
        : { conflict: "idempotency_key_reused" };
    }
    try {
      this.database.run(sql`
        INSERT INTO job (
          id, project_id, type, input, stage, result, error_code, error_message,
          idempotency_key, input_hash, worker_id, heartbeat_at, created_at, started_at, finished_at
        ) VALUES (
          ${job.id}, ${job.projectId}, ${job.type}, ${JSON.stringify(job.input)}, NULL, NULL, NULL, NULL,
          ${job.idempotencyKey}, ${job.inputHash}, NULL, NULL, ${this.clock.now().toISOString()}, NULL, NULL
        )
      `);
    } catch (error) {
      if (job.idempotencyKey === null) throw error;
      const prior = this.findIdempotent(job);
      if (!prior) throw error;
      return prior.inputHash === job.inputHash
        ? { job: prior, reused: true }
        : { conflict: "idempotency_key_reused" };
    }
    const stored = await this.get(job.id);
    if (!stored) throw new Error("enqueued job was not found");
    return { job: stored, reused: false };
  }

  async get(id: JobId): Promise<Job | null> {
    const row = this.database.get<JobRow>(sql`${SELECT_JOB} WHERE id = ${id}`);
    return row ? toJob(row) : null;
  }

  async claim(id: JobId, workerId: string): Promise<boolean> {
    const now = this.clock.now().toISOString();
    return this.database.run(sql`
      UPDATE job SET status = 'running', worker_id = ${workerId}, heartbeat_at = ${now},
        started_at = ${now}, attempt = attempt + 1
      WHERE id = ${id} AND status = 'queued'
    `).changes === 1;
  }

  async nextQueued(
    types: string[],
    excluded: readonly { projectId: ProjectId; type: string }[],
  ): Promise<Job | null> {
    if (types.length === 0) return null;
    const exclusions = excluded.length
      ? sql` AND ${sql.join(excluded.map((pair) => sql`NOT (project_id IS ${pair.projectId} AND type = ${pair.type})`), sql` AND `)}`
      : sql``;
    const row = this.database.get<JobRow>(sql`
      ${SELECT_JOB}
      WHERE status = 'queued' AND type IN (${sql.join(types.map((type) => sql`${type}`), sql`, `)})
      ${exclusions}
      ORDER BY created_at, id LIMIT 1
    `);
    return row ? toJob(row) : null;
  }

  async updateProgress(id: JobId, progress: number, stage: string | null): Promise<void> {
    const bounded = Math.min(1, Math.max(0, progress));
    this.database.run(sql`
      UPDATE job SET progress = ${bounded}, stage = ${stage}
      WHERE id = ${id} AND status = 'running' AND progress <= ${bounded}
    `);
  }

  async heartbeat(id: JobId): Promise<void> {
    this.database.run(sql`
      UPDATE job SET heartbeat_at = ${this.clock.now().toISOString()}
      WHERE id = ${id} AND status = 'running'
    `);
  }

  async finish(id: JobId, outcome: JobOutcome): Promise<void> {
    const finishedAt = this.clock.now().toISOString();
    const result = outcome.status === "succeeded" ? JSON.stringify(outcome.result) : null;
    const errorCode = outcome.status === "failed" ? outcome.error.code : null;
    const errorMessage = outcome.status === "failed" ? outcome.error.message : null;
    this.database.run(sql`
      UPDATE job SET status = ${outcome.status},
        progress = CASE WHEN ${outcome.status} = 'succeeded' THEN 1 ELSE progress END,
        result = ${result}, error_code = ${errorCode}, error_message = ${errorMessage},
        cancel_requested = CASE WHEN ${outcome.status} = 'cancelled' THEN 1 ELSE cancel_requested END,
        worker_id = NULL, heartbeat_at = NULL, finished_at = ${finishedAt}
      WHERE id = ${id} AND status IN ('queued', 'running')
    `);
  }

  async requestCancel(id: JobId): Promise<void> {
    const now = this.clock.now().toISOString();
    const queued = this.database.run(sql`
      UPDATE job SET cancel_requested = 1, status = 'cancelled', finished_at = ${now}
      WHERE id = ${id} AND status = 'queued'
    `);
    if (queued.changes === 0) this.database.run(sql`
      UPDATE job SET cancel_requested = 1 WHERE id = ${id} AND status = 'running'
    `);
  }

  async isCancellationRequested(id: JobId): Promise<boolean> {
    return this.database.get<{ requested: number }>(sql`
      SELECT cancel_requested AS requested FROM job WHERE id = ${id}
    `)?.requested === 1;
  }

  async requeue(id: JobId): Promise<void> {
    this.database.run(sql`
      UPDATE job SET status = 'queued', cancel_requested = 0, worker_id = NULL,
        heartbeat_at = NULL, started_at = NULL, finished_at = NULL,
        error_code = NULL, error_message = NULL
      WHERE id = ${id} AND status = 'running'
    `);
  }

  async listStale(cutoff: Date): Promise<Job[]> {
    return this.database.all<JobRow>(sql`
      ${SELECT_JOB}
      WHERE status = 'running' AND heartbeat_at < ${cutoff.toISOString()}
      ORDER BY heartbeat_at
    `).map(toJob);
  }

  private findIdempotent(job: NewJob): Job | null {
    const row = this.database.get<JobRow>(sql`
      ${SELECT_JOB}
      WHERE project_id IS ${job.projectId} AND type = ${job.type} AND idempotency_key IS ${job.idempotencyKey}
      LIMIT 1
    `);
    return row ? toJob(row) : null;
  }
}
