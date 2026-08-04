import { ErrorCode, JobParamsSchema, TERMINAL_JOB_STATUSES, type JobDto } from "@vidcom/contracts";
import type { Job, JobId, JobStorePort } from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

function jobId(c: Context): JobId {
  const parsed = JobParamsSchema.safeParse({ jobId: c.req.param("jobId") });
  if (!parsed.success) {
    throw new HttpBoundaryError({ code: ErrorCode.SchemaInvalid, message: "job id is invalid", field: "jobId" });
  }
  return parsed.data.jobId as JobId;
}

function publicJob(job: Job): JobDto {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    result: job.result,
    error: job.error,
    warnings: job.warnings,
    cleanupPending: job.cleanupPending,
    attempt: job.attempt,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

async function requireJob(store: JobStorePort, id: JobId): Promise<Job> {
  const job = await store.get(id);
  if (!job) throw new HttpBoundaryError({ code: ErrorCode.NotFound, message: "job not found" });
  return job;
}

/** Read and cooperative-cancel routes; internal scheduler fields never cross HTTP. */
export function createJobRoutes(store: JobStorePort): Hono {
  const routes = new Hono();
  routes.get("/jobs/:jobId", async (c) => c.json(publicJob(await requireJob(store, jobId(c)))));
  routes.get("/jobs/:jobId/termination-proof", async (c) => {
    const id = jobId(c);
    const job = await requireJob(store, id);
    if (job.status !== "cancelled" && job.status !== "failed") {
      throw new HttpBoundaryError({
        code: ErrorCode.PreconditionRequired,
        message: "termination proof is available only for cancelled or failed jobs",
      });
    }
    const proof = await store.readTerminationProof?.(id) ?? null;
    if (!proof) throw new HttpBoundaryError({ code: ErrorCode.NotFound, message: "termination proof was not recorded" });
    return c.json(proof);
  });
  routes.post("/jobs/:jobId/cancel", async (c) => {
    const id = jobId(c);
    const job = await requireJob(store, id);
    if (TERMINAL_JOB_STATUSES.includes(job.status as (typeof TERMINAL_JOB_STATUSES)[number])) {
      return c.body(null, 200);
    }
    await store.requestCancel(id);
    return c.body(null, 202);
  });
  return routes;
}
