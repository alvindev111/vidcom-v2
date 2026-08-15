import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hashContent, startVidcomFoundation } from "@vidcom/cli";
import { nodeSchedulerTimers } from "@vidcom/adapter";
import {
  JobSchema,
  ListProjectsResponseSchema,
  PutProjectFileResponseSchema,
  StudioSnapshotResponseSchema,
  type ContentHash,
  type ProjectId,
} from "@vidcom/contracts";
import { canonicalizeJobInput, JobScheduler, type AbsolutePath, type JobId } from "@vidcom/core";
import { createServerApp, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";
import { createNoopProbeJobType } from "@vidcom/worker";
import { afterEach, describe, expect, it } from "vitest";

import { createSequentialIdPort } from "../support/deterministic";
import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function hashInput(input: unknown): ContentHash {
  return `sha256:${createHash("sha256").update(canonicalizeJobInput(input)).digest("hex")}` as ContentHash;
}

describe("Phase O foundation milestone", () => {
  it("lists, opens, edits, saves, runs a job and streams events for all three samples", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-milestone-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    for (const slug of ["kinetic-type", "swiss-grid", "warm-grain"]) {
      await writeSampleProject(workspaceRoot, { slug, id: `project_${slug.replace(/-/g, "_")}` });
    }
    const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
    const nativeDependenciesRoot = path.join(root, "extracted-native") as AbsolutePath;
    const foundation = await startVidcomFoundation({
      appDataRoot: path.join(root, "app-data"),
      workspaceRoot: workspaceRoot as AbsolutePath,
      nativeDependenciesRoot,
      holderId: "test:phase-o",
      clock,
      ids: createSequentialIdPort(),
    }, {
      async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
    });
    const nonces = new InMemoryNonceStore(clock);
    const sessions = new InMemorySessionStore(clock);
    const port = 43213;
    const app = createServerApp({
      port,
      uiOrigins: [],
      nonces,
      sessions,
      projectReads: {
        ...foundation.application.readDependencies,
        runtimeSource: foundation.infrastructure.runtimeSource,
        mimeFromPath: foundation.infrastructure.mimeFromPath,
      },
      projectWrites: {
        ...foundation.application.writeDependencies,
        reads: foundation.application.readDependencies,
        bgmSynth: foundation.infrastructure.bgmSynth,
        bgmLibrary: foundation.infrastructure.bgmLibrary,
        hashContent,
        mimeFromPath: foundation.infrastructure.mimeFromPath,
      },
      jobs: foundation.infrastructure.jobs,
      events: foundation.infrastructure.events,
    });
    const base = async (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Host", `127.0.0.1:${port}`);
      return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
    };
    const exchange = await base("/api/v1/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: nonces.issue() }),
    });
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const request = (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", cookie);
      return base(pathname, { ...init, headers });
    };

    try {
      expect(foundation.infrastructure.nativeDependenciesRoot).toBe(nativeDependenciesRoot);
      const listed = ListProjectsResponseSchema.parse(await (await request("/api/v1/projects")).json());
      expect(listed.projects.map((project) => project.slug).sort())
        .toEqual(["kinetic-type", "swiss-grid", "warm-grain"]);

      const scheduler = new JobScheduler(
        foundation.infrastructure.jobs,
        clock,
        createSequentialIdPort(),
        [createNoopProbeJobType({ sleep: async () => {} })],
        foundation.infrastructure.events,
        nodeSchedulerTimers,
      );
      const jobIds: JobId[] = [];
      for (const [index, project] of listed.projects.entries()) {
        const snapshot = StudioSnapshotResponseSchema.parse(
          await (await request(`/api/v1/projects/${project.id}/studio-snapshot`)).json(),
        );
        const marker = `<!-- phase-o-${project.slug} -->`;
        const saved = PutProjectFileResponseSchema.parse(await (await request(`/api/v1/projects/${project.id}/files`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: snapshot.entryFile.path,
            content: `${snapshot.entryFile.content}\n${marker}\n`,
            expectedContentHash: snapshot.entryFile.contentHash,
          }),
        })).json());
        expect(saved.file.content).toContain(marker);

        const input = { steps: 2, delayMs: 0 };
        const jobId = `job_phase_o_${index}` as JobId;
        jobIds.push(jobId);
        await foundation.infrastructure.jobs.enqueue({
          id: jobId,
          projectId: project.id as ProjectId,
          type: "noop-probe",
          input,
          inputHash: hashInput(input),
          idempotencyKey: `phase-o-${project.slug}`,
        });
      }
      await scheduler.runAvailable();
      await scheduler.waitForIdle();

      for (const jobId of jobIds) {
        const job = JobSchema.parse(await (await request(`/api/v1/jobs/${jobId}`)).json());
        expect(job).toMatchObject({ status: "succeeded", progress: 1 });
      }
      const persisted = await foundation.infrastructure.events.readFrom(0, 100);
      expect(persisted.events.filter((event) => event.type === "file.changed")).toHaveLength(3);
      expect(persisted.events.filter((event) => event.type === "job.done")).toHaveLength(3);

      const stream = await request("/api/v1/events", { headers: { "Last-Event-ID": "0" } });
      const reader = stream.body!.getReader();
      const firstChunk = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      expect(firstChunk).toContain("event:");
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      await foundation.stop();
    }
  });
});
