import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateDatabase, openVidcomDatabase, SqliteJobStore } from "@vidcom/adapter";
import { ErrorResponseSchema, GetJobResponseSchema, type ContentHash, type ProjectId } from "@vidcom/contracts";
import { canonicalizeJobInput, type JobId } from "@vidcom/core";
import { createServerApp, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";
import { afterEach, describe, expect, it } from "vitest";
import { dbRun } from "../support/database";

const roots: string[] = [];
const projectId = "project_jobs" as ProjectId;
const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-job-routes-"));
  roots.push(root);
  const database = openVidcomDatabase(root);
  await migrateDatabase(database);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, "/workspace", "jobs", clock.now().toISOString(), clock.now().toISOString());
  const jobs = new SqliteJobStore(database, clock);
  const input = { steps: 1, delayMs: 0 };
  const inputHash = `sha256:${createHash("sha256").update(canonicalizeJobInput(input)).digest("hex")}` as ContentHash;
  await jobs.enqueue({
    id: "job_api" as JobId, projectId, type: "noop-probe", input, inputHash, idempotencyKey: null,
  });

  const nonces = new InMemoryNonceStore(clock);
  const sessions = new InMemorySessionStore(clock);
  const port = 43210;
  const app = createServerApp({ port, uiOrigins: [], nonces, sessions, jobs });
  const request = async (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  };
  const exchange = await request("/api/v1/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: nonces.issue() }),
  });
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
  return {
    database,
    jobs,
    request: (pathname: string, init: RequestInit = {}) => request(pathname, {
      ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Cookie: cookie },
    }),
  };
}

describe("job HTTP routes", () => {
  it("returns only the public JobDto and maps missing jobs", async () => {
    const { database, request } = await fixture();
    try {
      const response = await request("/api/v1/jobs/job_api");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(GetJobResponseSchema.parse(body)).toMatchObject({ id: "job_api", status: "queued" });
      expect(body).not.toHaveProperty("input");
      expect(body).not.toHaveProperty("projectId");
      const missing = await request("/api/v1/jobs/job_missing");
      expect(missing.status).toBe(404);
      expect(ErrorResponseSchema.parse(await missing.json()).error.code).toBe("not_found");
    } finally {
      await database.destroy();
    }
  });

  it("accepts active cancellation and treats terminal cancellation as a no-op", async () => {
    const { database, jobs, request } = await fixture();
    try {
      expect((await request("/api/v1/jobs/job_api/cancel", { method: "POST" })).status).toBe(202);
      expect(await jobs.get("job_api" as JobId)).toMatchObject({ status: "cancelled" });
      expect((await request("/api/v1/jobs/job_api/cancel", { method: "POST" })).status).toBe(200);
    } finally {
      await database.destroy();
    }
  });
});
