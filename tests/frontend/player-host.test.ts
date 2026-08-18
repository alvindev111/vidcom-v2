// @vitest-environment node

import { describe, expect, it } from "vitest";

import { PlayerHost } from "../../src/components/studio/player-host";
import {
  readHyperframesPreflightHealth,
  type HyperframesPlayerElement,
} from "../../src/components/studio/hyperframes-player-environment";
import type {
  PreflightHealthResult,
  PreviewBufferEngine,
} from "../../src/components/studio/preview-buffer";

interface FakeEngine extends PreviewBufferEngine {
  id: string;
  disposed: number;
  shown: number;
  health: PreflightHealthResult | Promise<PreflightHealthResult>;
}

const health = (changeSeq: number): PreflightHealthResult => ({
  ok: true,
  reason: null,
  waitedMs: 150,
  health: {
    ready: true,
    timeline: true,
    scenesLoaded: true,
    collectorSeen: true,
    revision: changeSeq,
    changeSeq,
    scriptErrors: 0,
    rejections: 0,
    resourceErrors: 0,
  },
});

function fixture(sequence: Array<PreflightHealthResult | Promise<PreflightHealthResult>>) {
  const created: FakeEngine[] = [];
  const shown: FakeEngine[] = [];
  const generations: number[] = [];
  const host = new PlayerHost<FakeEngine>({
    projectToken: "project-a",
    id: "host-stable",
    environment: {
      createCandidate({ url, generation }) {
        generations.push(generation);
        const engine: FakeEngine = {
          id: `${url}-${created.length}`,
          currentTime: 0,
          duration: 5,
          paused: true,
          playbackRate: 1,
          muted: false,
          disposed: 0,
          shown: 0,
          health: sequence.shift()!,
          seek(time) { this.currentTime = time; },
          play() { this.paused = false; },
          pause() { this.paused = true; },
        };
        created.push(engine);
        return engine;
      },
      waitForHealth: async (engine) => engine.health,
      show(engine) { engine.shown += 1; shown.push(engine); },
      dispose(engine) { engine.disposed += 1; },
    },
  });
  return { host, created, shown, generations };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("PlayerHost", () => {
  it("reads collector identity, counters and every nested composition from the real adapter seam", () => {
    const collector = { scriptErrors: 0, rejections: 0, resourceErrors: 1 };
    const script = { dataset: { projectRevision: "7", changeSeq: "11" } };
    const document = {
      querySelector: () => script,
      querySelectorAll: () => [{ children: [{}] }, { children: [] }],
    };
    const engine = {
      ready: true,
      duration: 5,
      iframeElement: { contentDocument: document, contentWindow: { __vidcomHealth: collector } },
    } as unknown as HyperframesPlayerElement;

    expect(readHyperframesPreflightHealth(engine, true)).toEqual({
      ready: true,
      timeline: true,
      scenesLoaded: false,
      collectorSeen: true,
      revision: 7,
      changeSeq: 11,
      scriptErrors: 0,
      rejections: 0,
      resourceErrors: 1,
    });
  });

  it("keeps host identity and retries one stale candidate in the same generation", async () => {
    const runtime = fixture([health(1), health(1), health(2)]);
    await expect(runtime.host.mount("/preview")).resolves.toMatchObject({
      kind: "mounted",
      visibleChangeSeq: 1,
    });
    const initial = runtime.created[0]!;
    initial.currentTime = 8;
    initial.paused = false;
    initial.playbackRate = 1.5;
    initial.muted = true;

    await expect(runtime.host.requestReload({
      url: "/preview",
      targetChangeSeq: 2,
    })).resolves.toMatchObject({ kind: "swapped", visibleChangeSeq: 2 });

    expect(runtime.host.id).toBe("host-stable");
    expect(runtime.generations).toEqual([0, 1, 1]);
    expect(runtime.shown.map(({ id }) => id)).toEqual(["/preview-0", "/preview-2"]);
    expect(runtime.created[1]).toMatchObject({ shown: 0, disposed: 1 });
    expect(runtime.created[2]).toMatchObject({
      currentTime: 5,
      paused: false,
      playbackRate: 1.5,
      muted: true,
    });
    expect(initial.disposed).toBe(1);
  });

  it("reports stale after one retry and retains the visible engine", async () => {
    const runtime = fixture([health(4), health(4), health(4)]);
    await runtime.host.mount("/preview");
    const visible = runtime.created[0]!;

    await expect(runtime.host.requestReload({
      url: "/preview",
      targetChangeSeq: 5,
    })).resolves.toMatchObject({ kind: "rejected", reason: "preview_stale" });

    expect(visible).toMatchObject({ shown: 1, disposed: 0 });
    expect(runtime.created.slice(1)).toMatchObject([
      { shown: 0, disposed: 1 },
      { shown: 0, disposed: 1 },
    ]);
    expect(runtime.host.transport()).toMatchObject({
      time: visible.currentTime,
      paused: visible.paused,
    });
  });

  it("disposes the candidate and visible engine exactly once on unmount", async () => {
    const pendingHealth = deferred<PreflightHealthResult>();
    const runtime = fixture([health(1), pendingHealth.promise]);
    await runtime.host.mount("/preview");
    const reload = runtime.host.requestReload({ url: "/preview", targetChangeSeq: 2 });

    runtime.host.dispose();
    runtime.host.dispose();
    pendingHealth.resolve(health(2));
    await expect(reload).resolves.toMatchObject({ kind: "disposed" });
    expect(runtime.created).toMatchObject([
      { disposed: 1 },
      { disposed: 1 },
    ]);
  });
});
