import { NodeProcessRunner } from "../../packages/adapter/src/runtime/node-process-runner.ts";
import { JobScheduler, type Job, type JobId, type JobOutcome, type JobStorePort } from "@vidcom/core";
import type { ContentHash, ProjectId } from "@vidcom/contracts";

const now = () => new Date();
const job: Job = {
  id: "job_cancel_contract" as JobId,
  projectId: "project_cancel_contract" as ProjectId,
  type: "render-contract-probe",
  status: "queued",
  input: {},
  inputHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as ContentHash,
  idempotencyKey: null,
  progress: 0,
  stage: null,
  result: null,
  error: null,
  attempt: 0,
  cancelRequested: false,
  workerId: null,
  heartbeatAt: null,
  createdAt: now().toISOString(),
  startedAt: null,
  finishedAt: null,
};

class ProbeStore implements JobStorePort {
  readonly record = job;

  async enqueue(): Promise<{ job: Job; reused: boolean }> { return { job: this.record, reused: false }; }
  async get(id: JobId): Promise<Job | null> { return id === this.record.id ? { ...this.record } : null; }
  async claim(id: JobId, workerId: string): Promise<boolean> {
    if (id !== this.record.id || this.record.status !== "queued") return false;
    this.record.status = "running";
    this.record.workerId = workerId;
    this.record.attempt += 1;
    this.record.startedAt = now().toISOString();
    return true;
  }
  async nextQueued(): Promise<Job | null> { return this.record.status === "queued" ? { ...this.record } : null; }
  async updateProgress(): Promise<void> {}
  async heartbeat(): Promise<void> { this.record.heartbeatAt = now().toISOString(); }
  async finish(_id: JobId, outcome: JobOutcome): Promise<void> {
    this.record.status = outcome.status;
    this.record.result = outcome.status === "succeeded" ? outcome.result : null;
    this.record.error = outcome.status === "failed" ? outcome.error : null;
    this.record.workerId = null;
    this.record.finishedAt = now().toISOString();
  }
  async requestCancel(): Promise<void> { this.record.cancelRequested = true; }
  async isCancellationRequested(): Promise<boolean> { return this.record.cancelRequested; }
  async requeue(): Promise<void> { this.record.status = "queued"; }
  async listStale(): Promise<Job[]> { return []; }
}

const timers = {
  setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const store = new ProbeStore();
const processes = new NodeProcessRunner(10_000);
const scheduler = new JobScheduler(
  store,
  { now },
  { newId: () => "worker_cancel_contract" },
  [{
    type: job.type,
    concurrency: 1,
    idempotent: false,
    timeoutMs: 10_000,
    maxAttempts: 1,
    run: async (_input, context) => processes.run({
      command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 3000)"],
      signal: context.signal,
      timeoutMs: 10_000,
    }),
  }],
  undefined,
  timers,
);

await scheduler.runAvailable();
while (store.record.status !== "running") await Bun.sleep(10);
const requestedAt = performance.now();
await store.requestCancel(job.id as JobId);
await Bun.sleep(500);
const statusAfter500Ms = store.record.status;
await scheduler.waitForIdle();
const terminalAt = performance.now();

console.log(JSON.stringify({
  question: "Does a persisted cancel request abort JobExecutionContext.signal while ProcessPort.run is active?",
  statusAfter500Ms,
  terminalStatus: store.record.status,
  cancelLatencyMs: Math.round(terminalAt - requestedAt),
  signalWasConnectedToPersistedCancellation: statusAfter500Ms !== "running",
}, null, 2));

