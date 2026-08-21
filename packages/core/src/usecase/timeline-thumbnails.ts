import { ErrorCode, type ContentHash, type DomainError, type RelPath } from "@vidcom/contracts";

import type { ProjectRef } from "../domain/models";
import { canonicalizeJson } from "../service/canonical-json";
import { err, ok, type Result } from "../error/result";
import type {
  CompositionDependency,
  CompositionDependencyPort,
  CompositionPort,
  ResolvedThumbnailProfile,
  ThumbnailKey,
  ThumbnailCachePort,
  ThumbnailPort,
  ThumbnailProfileName,
  ThumbnailRenderResult,
  WorkspacePort,
} from "../port/ports";

const PROFILE_BOX_SIZE = 160;

export interface ThumbnailServiceDependencies {
  workspace: WorkspacePort;
  composition: CompositionPort;
  dependencies: CompositionDependencyPort;
  hashContent(content: string | Uint8Array): ContentHash;
  runtimeDigest: string;
  rendererVersion: string;
}

export interface ThumbnailPlan {
  fingerprint: ContentHash;
  profile: ResolvedThumbnailProfile;
  keys: ThumbnailKey[];
}

function schema(message: string, field: string): Result<never, DomainError> {
  return err({ code: ErrorCode.SchemaInvalid, message, field });
}

function resolvedProfile(
  width: number,
  height: number,
  fps: number,
  runtimeDigest: string,
  rendererVersion: string,
): ResolvedThumbnailProfile | null {
  if (![width, height, fps].every((value) => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(PROFILE_BOX_SIZE / width, PROFILE_BOX_SIZE / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    fps,
    runtimeDigest,
    rendererVersion,
  };
}

function orderedDependencies(dependencies: readonly CompositionDependency[]): CompositionDependency[] {
  return [...dependencies].sort((left, right) =>
    left.path.localeCompare(right.path, "en")
      || left.state.localeCompare(right.state, "en")
      || String(left.contentHash).localeCompare(String(right.contentHash), "en"));
}

/** Returns scene-local center samples rounded to the project frame grid and clamped before scene end. */
export function sampleTimelineThumbnailTimes(duration: number, count: number, fps: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0
    || !Number.isInteger(count) || count < 1
    || !Number.isFinite(fps) || fps <= 0) throw new TypeError("thumbnail sampling inputs are invalid");
  const lastFrame = Math.max(0, (Math.ceil(duration * fps) - 1) / fps);
  return Array.from({ length: count }, (_, index) =>
    Math.min(lastFrame, Math.round((((index + 0.5) * duration) / count) * fps) / fps));
}

/** Hashes the unambiguous canonical cache identity; storage namespaces it by project separately. */
export function thumbnailRenderKey(
  key: Pick<ThumbnailKey, "fingerprint" | "atSeconds" | "profile">,
  hashContent: ThumbnailServiceDependencies["hashContent"],
): string {
  return hashContent(canonicalizeJson({
    fingerprint: key.fingerprint,
    atSeconds: key.atSeconds,
    profile: key.profile,
  })).replace(/^sha256:/u, "");
}

/** Owns server-resolved thumbnail identity and sampling; scheduling and storage stay in infrastructure. */
export class ThumbnailService {
  constructor(private readonly dependencies: ThumbnailServiceDependencies) {
    if (!dependencies.runtimeDigest || !dependencies.rendererVersion) {
      throw new TypeError("thumbnail runtime identity is required");
    }
  }

  async plan(
    ref: ProjectRef,
    input: { sceneId: string; atSeconds: readonly number[]; profile: ThumbnailProfileName },
  ): Promise<Result<ThumbnailPlan, DomainError>> {
    if (input.profile !== "timeline-v1") return schema("thumbnail profile is not supported", "profile");
    if (input.atSeconds.length < 1 || input.atSeconds.length > 256) {
      return schema("thumbnail batch must contain from 1 to 256 marks", "atSeconds");
    }
    if (input.atSeconds.some((value) => !Number.isFinite(value) || value < 0)
      || new Set(input.atSeconds).size !== input.atSeconds.length) {
      return schema("thumbnail marks must be finite, non-negative and unique", "atSeconds");
    }
    const identity = await this.identity(ref, input.sceneId);
    if (!identity.ok) return identity;
    if (!Number.isFinite(identity.value.duration) || identity.value.duration <= 0) {
      return schema("scene duration must be positive", "sceneId");
    }
    if (input.atSeconds.some((value) => value >= identity.value.duration)) {
      return schema("thumbnail marks must be scene-local and before scene end", "atSeconds");
    }
    return ok({
      fingerprint: identity.value.fingerprint,
      profile: identity.value.profile,
      keys: input.atSeconds.map((atSeconds) => ({
        sceneId: input.sceneId,
        fingerprint: identity.value.fingerprint,
        atSeconds,
        profile: identity.value.profile,
      })),
    });
  }

  /** Required immediately before cache publication so a render cannot publish stale source identity. */
  async isFingerprintCurrent(
    ref: ProjectRef,
    sceneId: string,
    expected: ContentHash,
  ): Promise<Result<boolean, DomainError>> {
    const identity = await this.identity(ref, sceneId);
    return identity.ok ? ok(identity.value.fingerprint === expected) : identity;
  }

  renderKey(key: ThumbnailKey): string {
    return thumbnailRenderKey(key, this.dependencies.hashContent);
  }

  private async identity(ref: ProjectRef, sceneId: string): Promise<Result<{
    fingerprint: ContentHash;
    profile: ResolvedThumbnailProfile;
    duration: number;
  }, DomainError>> {
    try {
      const model = await this.dependencies.composition.parseProject(ref);
      const scene = model.scenes.find((candidate) => candidate.id === sceneId);
      if (!scene) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found" });
      const profile = resolvedProfile(
        model.project.width,
        model.project.height,
        model.frameRate ?? 30,
        this.dependencies.runtimeDigest,
        this.dependencies.rendererVersion,
      );
      if (!profile) {
        return err({ code: ErrorCode.DependencyGraphUnavailable, message: "project render profile is unavailable" });
      }
      const sourcePath = (scene.src ?? ref.entry) as RelPath;
      const resolved = await this.dependencies.workspace.resolve(ref, sourcePath, "read-source");
      if (!resolved.ok) {
        return err({ code: ErrorCode.DependencyGraphUnavailable, message: "scene source is unavailable" });
      }
      const sourceHash = await this.dependencies.workspace.readHash(resolved.value);
      if (!sourceHash) {
        return err({ code: ErrorCode.DependencyGraphUnavailable, message: "scene source is unavailable" });
      }
      const graph = await this.dependencies.dependencies.dependenciesOf(ref, sceneId);
      if (!graph.ok) return graph;
      const fingerprint = this.dependencies.hashContent(canonicalizeJson({
        scene: { path: sourcePath, contentHash: sourceHash },
        dependencies: orderedDependencies(graph.value),
        profile,
      }));
      return ok({ fingerprint, profile, duration: scene.duration });
    } catch (error) {
      return err({
        code: ErrorCode.DependencyGraphUnavailable,
        message: error instanceof Error ? error.message : "thumbnail identity is unavailable",
      });
    }
  }
}

type ThumbnailRequest = { sceneId: string; atSeconds: readonly number[]; profile: ThumbnailProfileName };
type ThumbnailPlanner = Pick<ThumbnailService, "plan" | "isFingerprintCurrent"> &
  Partial<Pick<ThumbnailService, "renderKey">>;

interface ScheduledBatch {
  ref: ProjectRef;
  input: ThumbnailRequest;
  signal: AbortSignal;
  /** Linked to the caller signal so daemon shutdown can abort work the caller still awaits. */
  controller: AbortController;
  plan: ThumbnailPlan;
  queueKey: string;
  state: "queued" | "active" | "settled";
  settled: Promise<void>;
  resolve(value: readonly ThumbnailRenderResult[]): void;
  reject(reason: unknown): void;
  queuedAbort(): void;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function failures(keys: readonly ThumbnailKey[], code: ErrorCode, message: string): ThumbnailRenderResult[] {
  return keys.map((key) => ({ key, result: err({ code, message }) }));
}

/** Process-wide bounded policy for interactive batches; the renderer remains an infrastructure port. */
export class ThumbnailBatchScheduler {
  private readonly activeLimit: number;
  private readonly queueLimit: number;
  private readonly cache: ThumbnailCachePort | undefined;
  private active = 0;
  private stopped = false;
  private readonly queue: ScheduledBatch[] = [];
  private readonly running = new Set<ScheduledBatch>();

  constructor(
    private readonly planner: ThumbnailPlanner,
    private readonly renderer: ThumbnailPort,
    limits: { activeLimit?: number; queueLimit?: number; cache?: ThumbnailCachePort } = {},
  ) {
    this.activeLimit = limits.activeLimit ?? 2;
    this.queueLimit = limits.queueLimit ?? 8;
    this.cache = limits.cache;
    if (!Number.isInteger(this.activeLimit) || this.activeLimit < 1
      || !Number.isInteger(this.queueLimit) || this.queueLimit < 0) {
      throw new TypeError("thumbnail scheduler limits are invalid");
    }
  }

  get status(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  /**
   * Drains the daemon before the workspace it renders against goes away.
   *
   * Interactive batches outlive the HTTP request that started them only until
   * the caller disconnects, so a workspace switch or shutdown has to abort them
   * explicitly and wait: a snapshot child that keeps running would write into an
   * app-data root the daemon has already released.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of [...this.queue]) entry.queuedAbort();
    const running = [...this.running];
    for (const entry of running) entry.controller.abort(abortError("thumbnail scheduler stopped"));
    await Promise.allSettled(running.map((entry) => entry.settled));
  }

  async request(
    ref: ProjectRef,
    input: ThumbnailRequest,
    signal: AbortSignal,
  ): Promise<readonly ThumbnailRenderResult[]> {
    if (signal.aborted) throw abortError("thumbnail request was aborted");
    if (this.stopped) throw abortError("thumbnail scheduler stopped");
    const planned = await this.planner.plan(ref, input);
    if (!planned.ok) throw planned.error;
    if (signal.aborted) throw abortError("thumbnail request was aborted");
    return this.requestPlanned(ref, input, planned.value, signal);
  }

  requestPlanned(
    ref: ProjectRef,
    input: ThumbnailRequest,
    plan: ThumbnailPlan,
    signal: AbortSignal,
  ): Promise<readonly ThumbnailRenderResult[]> {
    if (signal.aborted) return Promise.reject(abortError("thumbnail request was aborted"));
    if (this.stopped) return Promise.reject(abortError("thumbnail scheduler stopped"));
    const queueKey = canonicalizeJson({
      projectId: ref.id,
      sceneId: input.sceneId,
      profile: plan.profile,
    });
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      signal.addEventListener(
        "abort",
        () => controller.abort(abortError("thumbnail request was aborted")),
        { once: true },
      );
      const entry: ScheduledBatch = {
        ref,
        input,
        signal,
        controller,
        plan,
        queueKey,
        state: "queued",
        settled: Promise.resolve(),
        resolve,
        reject,
        queuedAbort: () => {
          if (entry.state !== "queued") return;
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          entry.state = "settled";
          reject(abortError("thumbnail request was aborted"));
        },
      };
      if (this.active < this.activeLimit) {
        this.start(entry);
        return;
      }
      const superseded = this.queue.findIndex((candidate) => candidate.queueKey === queueKey);
      if (superseded >= 0) {
        const [older] = this.queue.splice(superseded, 1);
        if (older) {
          older.signal.removeEventListener("abort", older.queuedAbort);
          older.state = "settled";
          older.reject(abortError("thumbnail request was superseded"));
        }
      } else if (this.queue.length >= this.queueLimit) {
        entry.state = "settled";
        resolve(failures(plan.keys, ErrorCode.ThumbnailCapacity, "thumbnail scheduler is at capacity"));
        return;
      }
      this.queue.push(entry);
      signal.addEventListener("abort", entry.queuedAbort, { once: true });
    });
  }

  private start(entry: ScheduledBatch): void {
    entry.signal.removeEventListener("abort", entry.queuedAbort);
    entry.state = "active";
    this.active += 1;
    this.running.add(entry);
    entry.settled = this.execute(entry).then(entry.resolve, entry.reject).finally(() => {
      entry.state = "settled";
      this.running.delete(entry);
      this.active -= 1;
      this.drain();
    });
  }

  private drain(): void {
    if (this.stopped) return;
    while (this.active < this.activeLimit && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.start(entry);
    }
  }

  private async execute(entry: ScheduledBatch): Promise<readonly ThumbnailRenderResult[]> {
    let plan = entry.plan;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cached = new Map<number, Uint8Array>();
      let renderKeys = plan.keys;
      if (this.cache) {
        if (!this.planner.renderKey) throw new TypeError("thumbnail cache requires render key planning");
        try {
          for (const key of plan.keys) {
            const bytes = await this.cache.get(entry.ref.id, this.planner.renderKey(key));
            if (bytes) cached.set(key.atSeconds, bytes);
          }
        } catch (error) {
          return failures(plan.keys, ErrorCode.StorageUnavailable,
            error instanceof Error ? error.message : "thumbnail cache read failed");
        }
        renderKeys = plan.keys.filter((key) => !cached.has(key.atSeconds));
        if (renderKeys.length === 0) {
          return plan.keys.map((key) => ({ key, result: ok(cached.get(key.atSeconds)!) }));
        }
      }
      const rendered = await this.renderer.renderBatch(entry.ref, renderKeys, entry.controller.signal);
      if (entry.controller.signal.aborted) throw abortError("thumbnail request was aborted");
      const combined = () => plan.keys.map((key) => {
        const bytes = cached.get(key.atSeconds);
        return bytes
          ? { key, result: ok(bytes) }
          : rendered.find((item) => item.key.atSeconds === key.atSeconds)
            ?? { key, result: err({ code: ErrorCode.Internal, message: "thumbnail renderer omitted a key" }) };
      });
      if (!rendered.some((item) => item.result.ok)) return combined();
      const current = await this.planner.isFingerprintCurrent(entry.ref, entry.input.sceneId, plan.fingerprint);
      if (!current.ok) return failures(plan.keys, current.error.code, current.error.message);
      if (current.value) {
        if (this.cache) {
          try {
            for (const item of rendered) {
              if (item.result.ok) {
                await this.cache.put(entry.ref.id, this.planner.renderKey!(item.key), item.result.value);
              }
            }
          } catch (error) {
            return failures(plan.keys, ErrorCode.StorageUnavailable,
              error instanceof Error ? error.message : "thumbnail cache publication failed");
          }
        }
        return combined();
      }
      if (attempt === 1) {
        return failures(plan.keys, ErrorCode.SourceChanging, "thumbnail source kept changing");
      }
      const replanned = await this.planner.plan(entry.ref, entry.input);
      if (!replanned.ok) return failures(plan.keys, replanned.error.code, replanned.error.message);
      plan = replanned.value;
    }
    return failures(plan.keys, ErrorCode.SourceChanging, "thumbnail source kept changing");
  }
}
