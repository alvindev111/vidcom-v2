import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateDatabase, nodeSchedulerTimers, openVidcomDatabase, SqliteEventOutbox, SqliteJobStore } from "@vidcom/adapter";
import { getNextHostedRuntime, handleNextHostedRequest } from "@vidcom/cli";
import type { ContentHash, ProjectId } from "@vidcom/contracts";
import { canonicalizeJobInput, JobScheduler, type JobId } from "@vidcom/core";
import { createEventRoutes, createServerApp, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";
import { createNoopProbeJobType } from "@vidcom/worker";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { createSequentialIdPort } from "../support/deterministic";
import { dbRun } from "../support/database";

const roots: string[] = [];
const projectId = "project_events" as ProjectId;

function mutableClock(initial: string) {
  let time = new Date(initial).getTime();
  return { now: () => new Date(time), advance(ms: number) { time += ms; } };
}

function inputHash(input: unknown): ContentHash {
  return `sha256:${createHash("sha256").update(canonicalizeJobInput(input)).digest("hex")}` as ContentHash;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  let text = "";
  while (!text.includes(needle)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  return text;
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("durable SSE", () => {
  it("emits resync instead of replaying across a retention gap", async () => {
    const app = new Hono().route("/", createEventRoutes({
      async append() { return 42; },
      async readFrom() { return { events: [], gap: true }; },
      async latestSeq() { return 42; },
    }, { pollMs: 50 }));
    const response = await app.request("http://local/events", { headers: { "Last-Event-ID": "1" } });
    const reader = response.body!.getReader();
    const text = await readUntil(reader, "outside_retention");
    await reader.cancel();
    expect(text).toContain("event: resync");
    expect(text).toContain('"latestSeq":42');
  });

  it("streams the same persisted job state exposed by polling and emits heartbeat comments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-sse-"));
    roots.push(root);
    const clock = mutableClock("2026-08-01T00:00:00.000Z");
    const database = openVidcomDatabase(root);
    await migrateDatabase(database);
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    projectId, "/workspace", "events", clock.now().toISOString(), clock.now().toISOString());
    const jobs = new SqliteJobStore(database, clock);
    const events = new SqliteEventOutbox(database, clock);
    const input = { steps: 2, delayMs: 0 };
    await jobs.enqueue({
      id: "job_events" as JobId, projectId, type: "noop-probe", input,
      inputHash: inputHash(input), idempotencyKey: null,
    });
    const scheduler = new JobScheduler(jobs, clock, createSequentialIdPort(), [
      createNoopProbeJobType({ sleep: async () => { clock.advance(250); } }),
    ], events, nodeSchedulerTimers);
    await scheduler.runAvailable();
    await scheduler.waitForIdle();

    const nonces = new InMemoryNonceStore(clock);
    const sessions = new InMemorySessionStore(clock);
    const port = 43211;
    const app = createServerApp({ port, uiOrigins: [], nonces, sessions, jobs, events });
    const baseRequest = async (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Host", `127.0.0.1:${port}`);
      return app.request(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
    };
    const exchange = await baseRequest("/api/v1/auth/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: nonces.issue() }),
    });
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const headers = { Host: `127.0.0.1:${port}`, Cookie: cookie };
    try {
      const polled = await app.request(`http://127.0.0.1:${port}/api/v1/jobs/job_events`, { headers });
      expect(await polled.json()).toMatchObject({ status: "succeeded", progress: 1 });
      const stream = await app.request(`http://127.0.0.1:${port}/api/v1/events`, { headers });
      expect(stream.headers.get("x-accel-buffering")).toBe("no");
      const reader = stream.body!.getReader();
      const text = await readUntil(reader, "event: job.done");
      await reader.cancel();
      expect(text).toContain("event: job.progress");
      expect(text).toContain("event: job.done");

      const heartbeatApp = new Hono().route("/", createEventRoutes(events, { pollMs: 5, heartbeatMs: 10 }));
      const heartbeat = await heartbeatApp.request("http://local/events", { headers: { "Last-Event-ID": String(await events.latestSeq()) } });
      const heartbeatReader = heartbeat.body!.getReader();
      let heartbeatText = "";
      while (!heartbeatText.includes(":hb")) {
        const chunk = await heartbeatReader.read();
        heartbeatText += new TextDecoder().decode(chunk.value);
      }
      await heartbeatReader.cancel();
      expect(heartbeatText).toContain(":hb\n\n");
    } finally {
      await database.destroy();
    }
  });

  it("passes an event through the Next catch-all host without buffering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-next-sse-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "events");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    const nonce = Buffer.alloc(32, 7).toString("base64url");
    const port = 49321;
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
    };
    process.env.VIDCOM_APP_DATA = path.join(root, "app-data");
    process.env.VIDCOM_WORKSPACE = workspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    const host = `127.0.0.1:${port}`;
    const runtime = await getNextHostedRuntime(port);
    try {
      const exchange = await handleNextHostedRequest(new Request(`http://${host}/api/v1/auth/exchange`, {
        method: "POST", headers: { Host: host, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
      }));
      const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
      const ref = (await runtime.foundation.infrastructure.workspace.listProjects())[0]!;
      await runtime.foundation.infrastructure.events.append({
        type: "file.changed", projectId: ref.id, payload: { path: "index.html", source: "test" },
      });
      const response = await handleNextHostedRequest(new Request(`http://${host}/api/v1/events`, {
        headers: { Host: host, Cookie: cookie },
      }));
      const reader = response.body!.getReader();
      const text = await readUntil(reader, "event: file.changed");
      await reader.cancel();
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(text).toContain("event: file.changed");
    } finally {
      await runtime.foundation.stop();
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA; else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE; else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE; else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
    }
  });
});
