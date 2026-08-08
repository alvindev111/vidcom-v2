import { Worker } from "node:worker_threads";

export const BROWSE_WORKER_CONCURRENCY = 2;
export const BROWSE_WORKER_TIMEOUT_MS = 10_000;

/**
 * The worker body, kept as a string on purpose.
 *
 * It MUST be created with `new Worker(source, { eval: true })` and MUST NOT be
 * loaded from a file path. A packaged binary has no file for a worker to read,
 * and the failure is not an error — the worker never starts and the request
 * waits forever. That is the exact mechanism that hung esbuild in spike S1b,
 * and the ordinary way of writing this is the wrong way, so the constraint is
 * repeated here where the mistake would be made.
 */
export const BROWSE_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { readdirSync, statSync } = require("node:fs");

parentPort.on("message", (request) => {
  try {
    if (request.kind === "read") {
      const entries = readdirSync(request.path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
      parentPort.postMessage({ id: request.id, ok: true, entries });
      return;
    }
    if (request.kind === "identity") {
      const stat = statSync(request.path, { bigint: true });
      parentPort.postMessage({
        id: request.id,
        ok: true,
        identity: { device: stat.dev.toString(), inode: stat.ino.toString() },
      });
      return;
    }
    parentPort.postMessage({ id: request.id, ok: false, code: "unsupported" });
  } catch (error) {
    parentPort.postMessage({ id: request.id, ok: false, code: error.code ?? "unknown" });
  }
});
`;

export interface BrowseWorkerRequest {
  kind: "read" | "identity";
  path: string;
}

export type BrowseWorkerResponse =
  | { ok: true; entries?: unknown; identity?: unknown }
  | { ok: false; code: string };

interface Pending {
  resolve: (value: BrowseWorkerResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  worker: Worker;
}

/**
 * Runs filesystem reads off the event loop, bounded and interruptible.
 *
 * Bounded because a browse of a huge directory is slow enough to starve the
 * daemon if every request gets its own thread. Interruptible because a hung
 * read has to end as an error rather than holding a request open: a worker that
 * exceeds its budget is **terminated**, not merely abandoned, since abandoning
 * it leaves the thread doing the work that timed out.
 */
export class BrowseWorkerPool {
  private readonly idle: Worker[] = [];
  private readonly waiting: ((worker: Worker) => void)[] = [];
  private readonly live = new Set<Worker>();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly concurrency: number = BROWSE_WORKER_CONCURRENCY,
    private readonly timeoutMs: number = BROWSE_WORKER_TIMEOUT_MS,
  ) {}

  // Named startWorker, not spawn: this creates a thread, not a child process,
  // and the spawn audit rightly looks for the latter.
  private startWorker(): Worker {
    // `eval: true` is the whole point; see BROWSE_WORKER_SOURCE.
    const worker = new Worker(BROWSE_WORKER_SOURCE, { eval: true });
    worker.unref();
    this.live.add(worker);
    return worker;
  }

  private async acquire(): Promise<Worker> {
    const free = this.idle.pop();
    if (free) return free;
    if (this.live.size < this.concurrency) return this.startWorker();
    return new Promise<Worker>((resolve) => this.waiting.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  private retire(worker: Worker): void {
    this.live.delete(worker);
    void worker.terminate();
    const next = this.waiting.shift();
    if (next && !this.closed) next(this.startWorker());
  }

  async run(request: BrowseWorkerRequest): Promise<BrowseWorkerResponse> {
    if (this.closed) return { ok: false, code: "closed" };
    const worker = await this.acquire();
    const id = (this.sequence += 1);

    return new Promise<BrowseWorkerResponse>((resolve) => {
      const settle = (response: BrowseWorkerResponse, keep: boolean): void => {
        clearTimeout(pending.timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        if (keep) this.release(worker);
        else this.retire(worker);
        resolve(response);
      };
      const onMessage = (message: { id: number } & BrowseWorkerResponse): void => {
        if (message.id !== id) return;
        settle(message, true);
      };
      const onError = (): void => { settle({ ok: false, code: "worker_failed" }, false); };
      const pending: Pending = {
        resolve,
        worker,
        timer: setTimeout(() => {
          // Terminated, not abandoned: an abandoned worker keeps doing the work
          // that already timed out.
          settle({ ok: false, code: "timeout" }, false);
        }, this.timeoutMs),
      };
      pending.timer.unref?.();

      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.postMessage({ ...request, id });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = [...this.live];
    this.live.clear();
    this.idle.length = 0;
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
