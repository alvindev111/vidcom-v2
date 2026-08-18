import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ok,
  ThumbnailBatchScheduler,
  type AbsolutePath,
  type ProjectRef,
  type ThumbnailKey,
  type ThumbnailCachePort,
  type ThumbnailPlan,
  type ThumbnailPort,
  type ThumbnailProfileName,
} from "@vidcom/core";

const ref: ProjectRef = {
  id: "project_scheduler" as ProjectId,
  slug: "scheduler",
  root: "/workspace/scheduler" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const profile = {
  width: 160,
  height: 90,
  fps: 30,
  runtimeDigest: "runtime:a",
  rendererVersion: "renderer:v1",
};
const fingerprint = (value: string) => `sha256:${value.padEnd(64, "0")}` as ContentHash;

function plan(sceneId: string, atSeconds: readonly number[], generation = "a"): ThumbnailPlan {
  const identity = fingerprint(generation);
  return {
    fingerprint: identity,
    profile,
    keys: atSeconds.map((at) => ({ sceneId, atSeconds: at, fingerprint: identity, profile })),
  };
}

const request = (sceneId: string, atSeconds: readonly number[] = [0.5]) => ({
  sceneId,
  atSeconds,
  profile: "timeline-v1" as ThumbnailProfileName,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ThumbnailBatchScheduler", () => {
  it("bounds the daemon at two active and eight queued batches, then returns finite capacity failures", async () => {
    const releases: Array<ReturnType<typeof deferred<void>>> = [];
    let calls = 0;
    const renderer: ThumbnailPort = {
      async renderBatch(_ref, keys) {
        calls += 1;
        const release = deferred<void>();
        releases.push(release);
        await release.promise;
        return keys.map((key) => ({ key, result: ok(new Uint8Array([1])) }));
      },
    };
    const planner = {
      async plan(_ref: ProjectRef, input: ReturnType<typeof request>) { return ok(plan(input.sceneId, input.atSeconds)); },
      async isFingerprintCurrent() { return ok(true); },
    };
    const scheduler = new ThumbnailBatchScheduler(planner, renderer);
    const pending = Array.from({ length: 10 }, (_, index) =>
      scheduler.request(ref, request(`scene-${index}`), new AbortController().signal));
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.status).toEqual({ active: 2, queued: 8 });
    expect(calls).toBe(2);

    await expect(scheduler.request(ref, request("scene-overflow"), new AbortController().signal))
      .resolves.toMatchObject([{ result: { ok: false, error: { code: ErrorCode.ThumbnailCapacity } } }]);
    expect(calls).toBe(2);

    for (let index = 0; index < pending.length; index += 1) {
      while (!releases[index]) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releases[index]!.resolve();
    }
    await Promise.all(pending);
    expect(scheduler.status).toEqual({ active: 0, queued: 0 });
  });

  it("supersedes only an older queued batch with the same project, scene and profile", async () => {
    const blockers = [deferred<void>(), deferred<void>()];
    let calls = 0;
    const renderer: ThumbnailPort = {
      async renderBatch(_ref, keys) {
        const call = calls++;
        if (call < 2) await blockers[call]!.promise;
        return keys.map((key) => ({ key, result: ok(new Uint8Array([call])) }));
      },
    };
    const planner = {
      async plan(_ref: ProjectRef, input: ReturnType<typeof request>) { return ok(plan(input.sceneId, input.atSeconds)); },
      async isFingerprintCurrent() { return ok(true); },
    };
    const scheduler = new ThumbnailBatchScheduler(planner, renderer);
    const activeA = scheduler.request(ref, request("active-a"), new AbortController().signal);
    const activeB = scheduler.request(ref, request("active-b"), new AbortController().signal);
    const older = scheduler.request(ref, request("queued", [0.25]), new AbortController().signal);
    const newer = scheduler.request(ref, request("queued", [0.75]), new AbortController().signal);

    await expect(older).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.status).toEqual({ active: 2, queued: 1 });
    blockers[0]!.resolve();
    await expect(newer).resolves.toMatchObject([{ key: { atSeconds: 0.75 } }]);
    blockers[1]!.resolve();
    await Promise.all([activeA, activeB]);
  });

  it("removes an aborted queued batch immediately", async () => {
    const blocker = deferred<void>();
    const renderer: ThumbnailPort = {
      async renderBatch(_ref, keys) {
        await blocker.promise;
        return keys.map((key) => ({ key, result: ok(new Uint8Array()) }));
      },
    };
    const planner = {
      async plan(_ref: ProjectRef, input: ReturnType<typeof request>) { return ok(plan(input.sceneId, input.atSeconds)); },
      async isFingerprintCurrent() { return ok(true); },
    };
    const scheduler = new ThumbnailBatchScheduler(planner, renderer, { activeLimit: 1, queueLimit: 1 });
    const active = scheduler.request(ref, request("active"), new AbortController().signal);
    const controller = new AbortController();
    const queued = scheduler.request(ref, request("queued"), controller.signal);
    await Promise.resolve();
    expect(scheduler.status).toEqual({ active: 1, queued: 1 });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.status).toEqual({ active: 1, queued: 0 });
    blocker.resolve();
    await active;
  });

  it("replans once after source drift and stops with source_changing after the second drift", async () => {
    let generation = 0;
    let currentChecks = 0;
    const rendered: ThumbnailKey[][] = [];
    const planner = {
      async plan(_ref: ProjectRef, input: ReturnType<typeof request>) {
        generation += 1;
        return ok(plan(input.sceneId, input.atSeconds, String(generation)));
      },
      async isFingerprintCurrent() {
        currentChecks += 1;
        return ok(false);
      },
    };
    const renderer: ThumbnailPort = {
      async renderBatch(_ref, keys) {
        rendered.push([...keys]);
        return keys.map((key) => ({ key, result: ok(new Uint8Array([1])) }));
      },
    };
    const scheduler = new ThumbnailBatchScheduler(planner, renderer);

    await expect(scheduler.request(ref, request("changing"), new AbortController().signal))
      .resolves.toMatchObject([{ result: { ok: false, error: { code: ErrorCode.SourceChanging } } }]);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]![0]!.fingerprint).not.toBe(rendered[1]![0]!.fingerprint);
    expect(currentChecks).toBe(2);
  });

  it("returns only the replanned generation when the single source-drift retry stabilizes", async () => {
    let generation = 0;
    let checks = 0;
    const planner = {
      async plan(_ref: ProjectRef, input: ReturnType<typeof request>) {
        generation += 1;
        return ok(plan(input.sceneId, input.atSeconds, String(generation)));
      },
      async isFingerprintCurrent() { checks += 1; return ok(checks === 2); },
    };
    const renderer: ThumbnailPort = {
      async renderBatch(_ref, renderedKeys) {
        return renderedKeys.map((key) => ({ key, result: ok(new Uint8Array([generation])) }));
      },
    };
    const scheduler = new ThumbnailBatchScheduler(planner, renderer);

    const result = await scheduler.request(ref, request("stabilizes"), new AbortController().signal);

    expect(result).toMatchObject([{ result: { ok: true, value: new Uint8Array([2]) } }]);
    expect(result[0]!.key.fingerprint).toBe(fingerprint("2"));
    expect(generation).toBe(2);
  });

  it("publishes only after the current-fingerprint check and serves the next request without rendering", async () => {
    const events: string[] = [];
    const stored = new Map<string, Uint8Array>();
    const cache: ThumbnailCachePort = {
      async get(_projectId, renderKey) { events.push("get"); return stored.get(renderKey) ?? null; },
      async put(_projectId, renderKey, bytes) { events.push("put"); stored.set(renderKey, bytes); },
    };
    const planner = {
      async plan(_ref: ProjectRef, input: ReturnType<typeof request>) { return ok(plan(input.sceneId, input.atSeconds)); },
      async isFingerprintCurrent() { events.push("current"); return ok(true); },
      renderKey(key: ThumbnailKey) { return String(key.atSeconds).padEnd(64, "0"); },
    };
    let renders = 0;
    const renderer: ThumbnailPort = {
      async renderBatch(_ref, renderedKeys) {
        events.push("render");
        renders += 1;
        return renderedKeys.map((renderedKey) => ({ key: renderedKey, result: ok(new Uint8Array([7])) }));
      },
    };
    const scheduler = new ThumbnailBatchScheduler(planner, renderer, { cache });

    await expect(scheduler.request(ref, request("cached"), new AbortController().signal))
      .resolves.toMatchObject([{ result: { ok: true, value: new Uint8Array([7]) } }]);
    expect(events).toEqual(["get", "render", "current", "put"]);
    events.length = 0;
    await expect(scheduler.request(ref, request("cached"), new AbortController().signal))
      .resolves.toMatchObject([{ result: { ok: true, value: new Uint8Array([7]) } }]);
    expect(events).toEqual(["get"]);
    expect(renders).toBe(1);
  });
});
