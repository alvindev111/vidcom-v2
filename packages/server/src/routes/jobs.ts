import { ErrorCode, JobParamsSchema, type JobDto } from "@vidcom/contracts";
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
  routes.post("/jobs/:jobId/cancel", async (c) => {
    const id = jobId(c);
    const job = await requireJob(store, id);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return c.body(null, 200);
    await store.requestCancel(id);
    return c.body(null, 202);
  });
  return routes;
}
