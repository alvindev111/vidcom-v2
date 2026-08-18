// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  PreviewBufferCoordinator,
  waitForPreflightHealth,
  type PreflightHealthResult,
  type PreflightHealthSnapshot,
  type PreviewBufferEngine,
} from "../../src/components/studio/preview-buffer";

const healthy = (changeSeq: number): PreflightHealthResult => ({
  ok: true,
  reason: null,
  waitedMs: 150,
  health: {
    ready: true,
    timeline: true,
    scenesLoaded: true,
    collectorSeen: true,
    scriptErrors: 0,
    rejections: 0,
    resourceErrors: 0,
    revision: changeSeq,
    changeSeq,
  },
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface FakeEngine extends PreviewBufferEngine {
  id: string;
  disposed: number;
  shown: number;
  seeks: number[];
  plays: number;
  pauses: number;
}

function engine(id: string, overrides: Partial<FakeEngine> = {}): FakeEngine {
  return {
    id,
    currentTime: 0,
    duration: 10,
    paused: true,
    playbackRate: 1,
    muted: false,
    disposed: 0,
    shown: 0,
    seeks: [],
    plays: 0,
    pauses: 0,
    seek(time) { this.currentTime = time; this.seeks.push(time); },
    play() { this.paused = false; this.plays += 1; },
    pause() { this.paused = true; this.pauses += 1; },
    ...overrides,
  };
}

function fixture(visible = engine("visible"), visibleChangeSeq = 0) {
  const waits = new Map<string, ReturnType<typeof deferred<PreflightHealthResult>>>();
  const created: FakeEngine[] = [];
  let activeCandidates = 0;
  let maxCandidates = 0;
  const coordinator = new PreviewBufferCoordinator<FakeEngine>({
    projectToken: "project-a",
    visible,
    visibleChangeSeq,
    environment: {
      createCandidate({ url }) {
        const candidate = engine(url);
        created.push(candidate);
        waits.set(url, deferred());
        activeCandidates += 1;
        maxCandidates = Math.max(maxCandidates, activeCandidates);
        return candidate;
      },
      waitForHealth(candidate) { return waits.get(candidate.id)!.promise; },
      show(candidate) { candidate.shown += 1; activeCandidates -= 1; },
      dispose(candidate) {
        if (candidate.disposed === 0 && candidate !== visible && candidate.shown === 0) activeCandidates -= 1;
        candidate.disposed += 1;
      },
    },
  });
  return { coordinator, visible, waits, created, maxCandidates: () => maxCandidates };
}

describe("preview preflight health", () => {
  it("requires structural health to stay quiet for 150 ms and times out at 2.5 s", async () => {
    let now = 0;
    const snapshot = (): PreflightHealthSnapshot => ({
      ready: now >= 50,
      timeline: now >= 50,
      scenesLoaded: now >= 50,
      collectorSeen: now >= 50,
      scriptErrors: 0,
      rejections: 0,
      resourceErrors: 0,
      revision: 9,
      changeSeq: 9,
    });
    const result = await waitForPreflightHealth(snapshot, {
      clock: { now: () => now, delay: async (ms) => { now += ms; } },
    });
    expect(result).toMatchObject({ ok: true, waitedMs: 200, health: { changeSeq: 9 } });

    now = 0;
    const timeout = await waitForPreflightHealth(() => ({ ...snapshot(), ready: false }), {
      clock: { now: () => now, delay: async (ms) => { now += ms; } },
    });
    expect(timeout).toMatchObject({ ok: false, reason: "timeout", waitedMs: 2_500 });
  });

  it("rejects reported script/resource/rejection errors without waiting out the timeout", async () => {
    let delayed = 0;
    const result = await waitForPreflightHealth(() => ({
      ...healthy(1).health,
      scriptErrors: 1,
    }), {
      clock: { now: () => delayed, delay: async (ms) => { delayed += ms; } },
    });
    expect(result).toMatchObject({ ok: false, reason: "reported-error", waitedMs: 0 });
  });
});

describe("PreviewBufferCoordinator", () => {
  it("samples transport after health, clamps, restores every field and then swaps", async () => {
    const live = engine("visible", { currentTime: 1, paused: false, playbackRate: 1.5, muted: true });
    const runtime = fixture(live);
    const pending = runtime.coordinator.requestReload({
      projectToken: "project-a",
      url: "candidate",
      targetChangeSeq: 1,
    });
    live.currentTime = 12;
    runtime.created[0]!.duration = 4;
    runtime.waits.get("candidate")!.resolve(healthy(1));

    await expect(pending).resolves.toMatchObject({ kind: "swapped", visibleChangeSeq: 1 });
    expect(runtime.created[0]).toMatchObject({ seeks: [4], playbackRate: 1.5, muted: true, plays: 1, shown: 1 });
    expect(live.disposed).toBe(1);
  });

  it("rejects an unhealthy candidate and leaves the visible engine painting", async () => {
    const runtime = fixture();
    const pending = runtime.coordinator.requestReload({ projectToken: "project-a", url: "broken", targetChangeSeq: 1 });
    runtime.waits.get("broken")!.resolve({
      ...healthy(1),
      ok: false,
      reason: "timeout",
      health: { ...healthy(1).health, scenesLoaded: false },
    });

    await expect(pending).resolves.toMatchObject({ kind: "rejected", reason: "preview_unhealthy" });
    expect(runtime.visible.disposed).toBe(0);
    expect(runtime.created[0]).toMatchObject({ disposed: 1, shown: 0 });
    expect(runtime.coordinator.snapshot()).toMatchObject({ visibleChangeSeq: 0, error: "preview_unhealthy" });
  });

  it("is latest-wins across A/B/C, coalesces duplicates and ignores late failures", async () => {
    const runtime = fixture();
    const a = runtime.coordinator.requestReload({ projectToken: "project-a", url: "A", targetChangeSeq: 1 });
    const b = runtime.coordinator.requestReload({ projectToken: "project-a", url: "B", targetChangeSeq: 2 });
    const duplicateB = runtime.coordinator.requestReload({ projectToken: "project-a", url: "B-duplicate", targetChangeSeq: 2 });
    const c = runtime.coordinator.requestReload({ projectToken: "project-a", url: "C", targetChangeSeq: 3 });
    expect(runtime.maxCandidates()).toBe(1);
    await expect(duplicateB).resolves.toMatchObject({ kind: "coalesced" });

    runtime.waits.get("C")!.resolve(healthy(3));
    await expect(c).resolves.toMatchObject({ kind: "swapped", visibleChangeSeq: 3 });
    runtime.waits.get("A")!.resolve({ ...healthy(1), ok: false, reason: "reported-error" });
    runtime.waits.get("B")!.resolve(healthy(2));
    await expect(a).resolves.toMatchObject({ kind: "superseded" });
    await expect(b).resolves.toMatchObject({ kind: "superseded" });

    expect(runtime.coordinator.snapshot()).toMatchObject({
      desiredChangeSeq: 3,
      visibleChangeSeq: 3,
      candidateGeneration: null,
      error: null,
    });
    expect(runtime.created.map(({ id, shown }) => [id, shown])).toEqual([["A", 0], ["B", 0], ["C", 1]]);
  });

  it("advances desired and visible to a collector newer than the target", async () => {
    const runtime = fixture();
    const pending = runtime.coordinator.requestReload({ projectToken: "project-a", url: "D", targetChangeSeq: 3 });
    runtime.waits.get("D")!.resolve(healthy(4));
    await expect(pending).resolves.toMatchObject({ kind: "swapped", visibleChangeSeq: 4 });
    await expect(runtime.coordinator.requestReload({
      projectToken: "project-a",
      url: "D-duplicate",
      targetChangeSeq: 4,
    })).resolves.toMatchObject({ kind: "coalesced" });
    expect(runtime.coordinator.snapshot()).toMatchObject({ desiredChangeSeq: 4, visibleChangeSeq: 4 });
  });

  it("disposes both engines once and prevents a late swap after project unmount", async () => {
    const runtime = fixture();
    const pending = runtime.coordinator.requestReload({ projectToken: "project-a", url: "late", targetChangeSeq: 1 });
    runtime.coordinator.dispose();
    runtime.waits.get("late")!.resolve(healthy(1));
    await expect(pending).resolves.toMatchObject({ kind: "disposed" });
    expect(runtime.visible.disposed).toBe(1);
    expect(runtime.created[0]!.disposed).toBe(1);
    await expect(runtime.coordinator.requestReload({
      projectToken: "project-b",
      url: "wrong-project",
      targetChangeSeq: 2,
    })).resolves.toMatchObject({ kind: "disposed" });
  });
});
