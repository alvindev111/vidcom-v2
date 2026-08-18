import {
  PreviewBufferCoordinator,
  type PreflightHealthResult,
  type PreviewBufferEngine,
  type PreviewBufferEnvironment,
  type PreviewReloadResult,
} from "./preview-buffer";

let nextHostId = 0;

export type PlayerHostMountResult =
  | { kind: "mounted"; visibleChangeSeq: number; health: PreflightHealthResult }
  | { kind: "rejected"; reason: "preview_unhealthy"; health: PreflightHealthResult }
  | { kind: "disposed" };

function healthy(result: PreflightHealthResult): boolean {
  const health = result.health;
  return result.ok &&
    health.ready &&
    health.timeline &&
    health.scenesLoaded &&
    health.collectorSeen &&
    health.scriptErrors === 0 &&
    health.rejections === 0 &&
    health.resourceErrors === 0;
}

/** Stable project-scoped owner around replaceable HyperFrames engine elements. */
export class PlayerHost<Engine extends PreviewBufferEngine> {
  readonly id: string;
  private readonly projectToken: string;
  private readonly environment: PreviewBufferEnvironment<Engine>;
  private readonly disposedEngines = new Set<Engine>();
  private coordinator: PreviewBufferCoordinator<Engine> | null = null;
  private visible: Engine | null = null;
  private mounting: { engine: Engine; controller: AbortController; generation: number } | null = null;
  private generation = 0;
  private disposed = false;

  constructor(input: {
    projectToken: string;
    environment: PreviewBufferEnvironment<Engine>;
    id?: string;
  }) {
    this.projectToken = input.projectToken;
    this.id = input.id ?? `player-host-${++nextHostId}`;
    this.environment = {
      ...input.environment,
      show: (engine) => {
        input.environment.show(engine);
        this.visible = engine;
      },
      dispose: (engine) => this.disposeEngine(engine, input.environment),
    };
  }

  async mount(url: string): Promise<PlayerHostMountResult> {
    if (this.disposed) return { kind: "disposed" };
    const generation = ++this.generation;
    this.mounting?.controller.abort();
    if (this.mounting) this.environment.dispose(this.mounting.engine);
    const controller = new AbortController();
    const engine = this.environment.createCandidate({ url, generation: 0, signal: controller.signal });
    const mounting = { engine, controller, generation };
    this.mounting = mounting;

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

    if (this.disposed || generation !== this.generation || this.mounting !== mounting) {
      this.environment.dispose(engine);
      return { kind: "disposed" };
    }
    this.mounting = null;
    if (!healthy(health)) {
      this.environment.dispose(engine);
      return { kind: "rejected", reason: "preview_unhealthy", health };
    }

    // Force the first runtime visibility tick without moving the transport.
    engine.seek(engine.currentTime);
    this.environment.show(engine);
    this.coordinator = new PreviewBufferCoordinator({
      projectToken: this.projectToken,
      visible: engine,
      visibleChangeSeq: health.health.changeSeq,
      environment: this.environment,
      staleRetries: 1,
    });
    return { kind: "mounted", visibleChangeSeq: health.health.changeSeq, health };
  }

  requestReload(input: { url: string; targetChangeSeq: number }): Promise<PreviewReloadResult> {
    if (this.disposed || !this.coordinator) return Promise.resolve({ kind: "disposed" });
    return this.coordinator.requestReload({ ...input, projectToken: this.projectToken });
  }

  transport() {
    const engine = this.visible;
    return {
      time: engine?.currentTime ?? 0,
      paused: engine?.paused ?? true,
      rate: engine?.playbackRate ?? 1,
      muted: engine?.muted ?? false,
    };
  }

  seek(seconds: number): void { this.visible?.seek(seconds); }
  play(): void { this.visible?.play(); }
  pause(): void { this.visible?.pause(); }
  setPlaybackRate(rate: number): void {
    if (this.visible) this.visible.playbackRate = rate;
  }
  setMuted(muted: boolean): void {
    if (this.visible) this.visible.muted = muted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.mounting?.controller.abort();
    if (this.coordinator) this.coordinator.dispose();
    else if (this.mounting) this.environment.dispose(this.mounting.engine);
    this.mounting = null;
    this.coordinator = null;
    this.visible = null;
  }

  private disposeEngine(
    engine: Engine,
    environment: PreviewBufferEnvironment<Engine>,
  ): void {
    if (this.disposedEngines.has(engine)) return;
    this.disposedEngines.add(engine);
    environment.dispose(engine);
    if (this.visible === engine) this.visible = null;
  }
}
