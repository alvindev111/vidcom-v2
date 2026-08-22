export const PREVIEW_HEALTH_QUIET_MS = 150;
export const PREVIEW_HEALTH_TIMEOUT_MS = 2_500;
const PREVIEW_HEALTH_POLL_MS = 25;

export interface PreflightHealthSnapshot {
  ready: boolean;
  timeline: boolean;
  scenesLoaded: boolean;
  collectorSeen: boolean;
  scriptErrors: number;
  rejections: number;
  resourceErrors: number;
  revision: number;
  changeSeq: number;
}

export interface PreflightHealthResult {
  ok: boolean;
  reason: "reported-error" | "timeout" | "cancelled" | null;
  health: PreflightHealthSnapshot;
  waitedMs: number;
}

interface HealthClock {
  now(): number;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const DEFAULT_HEALTH_CLOCK: HealthClock = {
  now: () => Date.now(),
  delay: defaultDelay,
};

function structurallyReady(health: PreflightHealthSnapshot): boolean {
  return health.ready && health.timeline && health.scenesLoaded && health.collectorSeen;
}

function reportedFailure(health: PreflightHealthSnapshot): boolean {
  return health.scriptErrors > 0 || health.rejections > 0 || health.resourceErrors > 0;
}

/** Polls the injected collector until the measured structural quiet-window contract settles. */
export async function waitForPreflightHealth(
  read: () => PreflightHealthSnapshot,
  options: {
    signal?: AbortSignal;
    quietMs?: number;
    timeoutMs?: number;
    pollMs?: number;
    clock?: HealthClock;
  } = {},
): Promise<PreflightHealthResult> {
  const clock = options.clock ?? DEFAULT_HEALTH_CLOCK;
  const quietMs = options.quietMs ?? PREVIEW_HEALTH_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? PREVIEW_HEALTH_TIMEOUT_MS;
  const pollMs = options.pollMs ?? PREVIEW_HEALTH_POLL_MS;
  const started = clock.now();
  let settledAt: number | null = null;

  while (true) {
    const health = read();
    const waitedMs = clock.now() - started;
    if (options.signal?.aborted) return { ok: false, reason: "cancelled", health, waitedMs };
    if (reportedFailure(health)) return { ok: false, reason: "reported-error", health, waitedMs };
    if (structurallyReady(health)) settledAt ??= clock.now();
    else settledAt = null;
    if (settledAt !== null && clock.now() - settledAt >= quietMs) {
      return { ok: true, reason: null, health, waitedMs };
    }
    if (waitedMs >= timeoutMs) return { ok: false, reason: "timeout", health, waitedMs };
    await clock.delay(Math.min(pollMs, timeoutMs - waitedMs), options.signal);
  }
}

export interface PreviewBufferEngine {
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  muted: boolean;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
}

export interface PreviewBufferEnvironment<Engine extends PreviewBufferEngine> {
  /** Creates one already-hidden candidate behind the visible engine. */
  createCandidate(input: { url: string; generation: number; signal: AbortSignal }): Engine;
  waitForHealth(engine: Engine, signal: AbortSignal): Promise<PreflightHealthResult>;
  /** Makes the prepared candidate visible without removing the old engine. */
  show(engine: Engine): void;
  dispose(engine: Engine): void;
  /** Releases environment-owned warm resources that are not represented by an engine. */
  disposeIdle?(): void;
}

export type PreviewReloadResult =
  | { kind: "swapped"; visibleChangeSeq: number }
  | { kind: "coalesced"; visibleChangeSeq: number }
  | {
      kind: "rejected";
      reason: "preview_unhealthy" | "preview_stale";
      health: PreflightHealthResult;
    }
  | { kind: "superseded" }
  | { kind: "disposed" };

interface Candidate<Engine> {
  engine: Engine;
  generation: number;
  controller: AbortController;
}

/** Latest-wins orchestration only; a DOM adapter supplies actual HyperFrames engines in 4.3b. */
export class PreviewBufferCoordinator<Engine extends PreviewBufferEngine> {
  private visible: Engine | null;
  private readonly environment: PreviewBufferEnvironment<Engine>;
  private readonly projectToken: string;
  private readonly staleRetries: number;
  private readonly disposedEngines = new Set<Engine>();
  private candidate: Candidate<Engine> | null = null;
  private generation = 0;
  private desiredChangeSeq: number;
  private visibleChangeSeq: number;
  private error: "preview_unhealthy" | "preview_stale" | null = null;
  private disposed = false;

  constructor(input: {
    projectToken: string;
    visible: Engine;
    visibleChangeSeq: number;
    environment: PreviewBufferEnvironment<Engine>;
    staleRetries?: number;
  }) {
    this.projectToken = input.projectToken;
    this.visible = input.visible;
    this.visibleChangeSeq = input.visibleChangeSeq;
    this.desiredChangeSeq = input.visibleChangeSeq;
    this.environment = input.environment;
    this.staleRetries = input.staleRetries ?? 0;
  }

  snapshot() {
    return {
      desiredChangeSeq: this.desiredChangeSeq,
      visibleChangeSeq: this.visibleChangeSeq,
      candidateGeneration: this.candidate?.generation ?? null,
      error: this.error,
      disposed: this.disposed,
    };
  }

  async requestReload(input: {
    projectToken: string;
    url: string;
    targetChangeSeq: number;
  }): Promise<PreviewReloadResult> {
    if (this.disposed) return { kind: "disposed" };
    if (input.projectToken !== this.projectToken) return { kind: "superseded" };
    if (input.targetChangeSeq <= this.desiredChangeSeq) {
      return { kind: "coalesced", visibleChangeSeq: this.visibleChangeSeq };
    }

    this.desiredChangeSeq = input.targetChangeSeq;
    this.error = null;
    this.dropCandidate();
    const generation = ++this.generation;
    for (let attempt = 0; attempt <= this.staleRetries; attempt += 1) {
      const controller = new AbortController();
      const engine = this.environment.createCandidate({ url: input.url, generation, signal: controller.signal });
      const candidate = { engine, generation, controller };
      this.candidate = candidate;

      let health: PreflightHealthResult;
      try {
        health = await this.environment.waitForHealth(engine, controller.signal);
      } catch {
        health = {
          ok: false,
          reason: controller.signal.aborted ? "cancelled" : "reported-error",
          waitedMs: 0,
          health: {
            ready: false,
            timeline: false,
            scenesLoaded: false,
            collectorSeen: false,
            scriptErrors: controller.signal.aborted ? 0 : 1,
            rejections: 0,
            resourceErrors: 0,
            revision: 0,
            changeSeq: 0,
          },
        };
      }

      if (this.disposed) {
        this.disposeOnce(engine);
        return { kind: "disposed" };
      }
      if (generation !== this.generation || this.candidate !== candidate) {
        this.disposeOnce(engine);
        return { kind: "superseded" };
      }
      if (!health.ok || !structurallyReady(health.health) || reportedFailure(health.health)) {
        this.candidate = null;
        this.disposeOnce(engine);
        this.error = "preview_unhealthy";
        return { kind: "rejected", reason: this.error, health };
      }
      if (health.health.changeSeq < input.targetChangeSeq) {
        this.candidate = null;
        this.disposeOnce(engine);
        if (attempt < this.staleRetries) continue;
        this.error = "preview_stale";
        return { kind: "rejected", reason: this.error, health };
      }

      const live = this.visible;
      if (!live) {
        this.candidate = null;
        this.disposeOnce(engine);
        return { kind: "disposed" };
      }
      // Sample only after health settles: a playing engine advances during preflight.
      const transport = {
        time: live.currentTime,
        paused: live.paused,
        rate: live.playbackRate,
        muted: live.muted,
      };
      engine.seek(Math.min(transport.time, Math.max(0, engine.duration)));
      engine.playbackRate = transport.rate;
      engine.muted = transport.muted;
      if (transport.paused) engine.pause();
      else engine.play();

      this.candidate = null;
      this.environment.show(engine);
      this.visible = engine;
      this.disposeOnce(live);
      this.visibleChangeSeq = Math.max(input.targetChangeSeq, health.health.changeSeq);
      this.desiredChangeSeq = Math.max(this.desiredChangeSeq, this.visibleChangeSeq);
      this.error = null;
      return { kind: "swapped", visibleChangeSeq: this.visibleChangeSeq };
    }
    throw new Error("preview reload retry loop exited without a result");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.dropCandidate();
    if (this.visible) this.disposeOnce(this.visible);
    this.visible = null;
  }

  private dropCandidate(): void {
    const current = this.candidate;
    if (!current) return;
    this.candidate = null;
    current.controller.abort();
    this.disposeOnce(current.engine);
  }

  private disposeOnce(engine: Engine): void {
    if (this.disposedEngines.has(engine)) return;
    this.disposedEngines.add(engine);
    this.environment.dispose(engine);
  }
}
