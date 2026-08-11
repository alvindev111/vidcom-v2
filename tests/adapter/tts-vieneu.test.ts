import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import {
  DOWNLOAD_CACHE_COMPONENTS,
  DownloadCacheCoordinator,
  VieNeuTtsProvider,
} from "@vidcom/adapter";
import type { ProcessPort, ProcessRunInput, TtsSynthesisRequest } from "@vidcom/core";

const directories: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  directories.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Real preset names from upstream; VidCom derives its ids from them rather than shipping a list. */
const PRESET_VOICES = ["Phạm Tuyên", "Minh Đức", "Trúc Ly"];

interface SidecarBehaviour {
  probe?: { ready: boolean; gpu: boolean; voices?: string[] } | "crash";
  offlineProbe?: { ready: boolean; gpu: boolean; voices?: string[] } | "crash";
  probeStderr?: string;
  offlineProbeStderr?: string;
  probeTimedOut?: boolean;
  /** Device the fake sidecar claims it actually ran on; defaults to the requested one. */
  effectiveDevice?: "cpu" | "gpu";
  exitCode?: number;
  stderr?: string;
  /** Fails the first N synthesis attempts, mimicking a truncated model download. */
  failFirst?: number;
  /**
   * What the sidecar echoes back as applied. Defaults to the request's own block;
   * `"omit"` mimics a worker.py older than the sampling controls.
   */
  sampling?: unknown;
}

function fakeSidecar(behaviour: SidecarBehaviour = {}, calls: ProcessRunInput[] = []): ProcessPort {
  let attempts = 0;
  return {
    async run(input) {
      calls.push(input);
      if (input.command.includes("--probe")) {
        const offline = input.environment?.HF_HUB_OFFLINE === "1";
        const selectedProbe = offline && behaviour.offlineProbe !== undefined
          ? behaviour.offlineProbe
          : behaviour.probe;
        if (selectedProbe === "crash") {
          throw new Error("spawn /Users/example/Downloads/python ENOENT");
        }
        const probe = selectedProbe ?? { ready: true, gpu: false };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            voices: PRESET_VOICES,
            engineVersion: "3.2.4",
            ...probe,
          }),
          stderr: offline
            ? behaviour.offlineProbeStderr ?? behaviour.probeStderr ?? ""
            : behaviour.probeStderr ?? "",
          timedOut: behaviour.probeTimedOut === true,
        };
      }
      attempts += 1;
      if (behaviour.failFirst && attempts <= behaviour.failFirst) {
        return { exitCode: 1, stdout: "", stderr: behaviour.stderr ?? "model download failed", timedOut: false };
      }
      if (behaviour.exitCode !== undefined && behaviour.exitCode !== 0) {
        return { exitCode: behaviour.exitCode, stdout: "", stderr: behaviour.stderr ?? "", timedOut: false };
      }
      const requestPath = input.command[input.command.indexOf("--request") + 1]!;
      const responsePath = input.command[input.command.indexOf("--response") + 1]!;
      const request = JSON.parse(await readFile(requestPath, "utf8")) as {
        device: "cpu" | "gpu";
        outputDir: string;
        sampling?: unknown;
        cues: { id: string }[];
      };
      const assets = [];
      for (const cue of request.cues) {
        const path = join(request.outputDir, `${cue.id}.vieneu.wav`);
        await writeFile(path, Buffer.alloc(1_024, 5));
        assets.push({ cueId: cue.id, path });
      }
      await writeFile(responsePath, JSON.stringify({
        schemaVersion: 1,
        provider: "vieneu",
        modelId: "vieneu-v3-turbo",
        modelRevision: "abc1234",
        effectiveDevice: behaviour.effectiveDevice ?? request.device,
        // The real sidecar echoes what it applied rather than what it was asked
        // for. `sampling: "omit"` stands in for a worker.py older than the
        // sampling controls, which reports none of it.
        ...(behaviour.sampling === "omit"
          ? {}
          : { sampling: behaviour.sampling ?? request.sampling }),
        assets,
      }), "utf8");
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
}

async function provider(behaviour: SidecarBehaviour = {}, calls: ProcessRunInput[] = []) {
  return new VieNeuTtsProvider({
    processes: fakeSidecar(behaviour, calls),
    command: () => ["python", "worker.py"],
    modelCacheRoot: await temporary("vidcom-models-"),
  });
}

async function cachedProvider(
  behaviour: SidecarBehaviour = {},
  calls: ProcessRunInput[] = [],
  offline = false,
) {
  const appDataRoot = await temporary("vidcom-app-data-");
  const cache = new DownloadCacheCoordinator({ cacheRoot: appDataRoot });
  const subject = new VieNeuTtsProvider({
    processes: fakeSidecar(behaviour, calls),
    command: () => ["python", "worker.py"],
    modelCacheRoot: cache.componentRoot(DOWNLOAD_CACHE_COMPONENTS.models),
    downloadCache: cache,
    offline,
  });
  return { appDataRoot, cache, subject };
}

/** Every test synthesizes after describing, the way the registry always does. */
async function described(behaviour: SidecarBehaviour = {}, calls: ProcessRunInput[] = []) {
  const subject = await provider(behaviour, calls);
  await subject.describe();
  return subject;
}

function request(overrides: Partial<TtsSynthesisRequest> = {}): TtsSynthesisRequest {
  return {
    cues: [{ id: "intro", text: "Xin chào" }],
    providerId: "vieneu",
    voiceId: "vieneu-v3-pham-tuyen",
    modelId: "vieneu-v3-turbo",
    languageCode: "vi",
    ratePercent: 0,
    computeDevice: "cpu",
    seed: 4_242,
    ...overrides,
  };
}

describe("VieNeuTtsProvider", () => {
  it("refuses a model cache path that is not absolute", async () => {
    expect(() => new VieNeuTtsProvider({
      processes: fakeSidecar(),
      command: () => ["python", "worker.py"],
      // A relative cache lands several gigabytes of weights wherever the process
      // happened to start — including inside the source checkout.
      modelCacheRoot: "models",
    })).toThrow(TypeError);
  });

  it("points the sidecar's model cache at the configured app-data root", async () => {
    const calls: ProcessRunInput[] = [];
    const subject = await described({}, calls);
    const scratchDir = await temporary("vidcom-scratch-");

    await subject.synthesize(request(), { scratchDir });

    const environment = calls.at(-1)?.environment ?? {};
    expect(environment.HF_HOME).toMatch(/vidcom-models-/);
    // hub and torch are pinned under the same root: leaving either unset lets
    // the library fall back to ~/.cache or the working directory.
    expect(environment.HF_HUB_CACHE).toContain("hub");
    expect(environment.TORCH_HOME).toContain("torch");
  });

  it("asks the sidecar to pin the sampler and hold the temperature down", async () => {
    const calls: ProcessRunInput[] = [];
    const subject = await described({}, calls);
    const scratchDir = await temporary("vidcom-scratch-");

    const produced = await subject.synthesize(request({ seed: 4_242 }), { scratchDir });

    const requestPath = calls.at(-1)!.command[calls.at(-1)!.command.indexOf("--request") + 1]!;
    const sent = JSON.parse(await readFile(requestPath, "utf8")) as {
      sampling?: { seed?: number; temperature?: number };
    };
    // v3 Turbo draws its prosody per call, so an unpinned sampler at the engine's
    // own 0.8 made each scene a different take of the same script.
    expect(sent.sampling?.seed).toBe(4_242);
    expect(sent.sampling?.temperature).toBeLessThan(0.8);
    expect(produced[0]?.metadata).toMatchObject({ seed: 4_242 });
  });

  it("records nothing about sampling when the installed sidecar is too old to report it", async () => {
    const subject = await described({ sampling: "omit" });
    const scratchDir = await temporary("vidcom-scratch-");

    const produced = await subject.synthesize(request(), { scratchDir });

    // `tts.vieneu.command` points at a worker.py the user configured, which can
    // predate these controls. Silence is the honest record: claiming the cue was
    // pinned when the sidecar ignored the request is the failure to avoid.
    expect(produced[0]?.metadata.seed).toBeUndefined();
    expect(produced[0]?.metadata.temperature).toBeUndefined();
  });

  it("drops a sampling echo that is not the shape it should be", async () => {
    const subject = await described({ sampling: { seed: "four thousand", temperature: null } });
    const scratchDir = await temporary("vidcom-scratch-");

    const produced = await subject.synthesize(request(), { scratchDir });

    // The echo ends up in the narration sidecar, which holds scalars only.
    expect(produced[0]?.metadata.seed).toBeUndefined();
    expect(produced[0]?.metadata.temperature).toBeUndefined();
  });

  it("coordinates a cold probe, then forces synthesis to reuse the completed cache offline", async () => {
    const calls: ProcessRunInput[] = [];
    const { cache, subject } = await cachedProvider({}, calls);

    expect((await subject.describe()).available).toBe(true);
    expect(calls[0]?.environment?.HF_HUB_OFFLINE).toBeUndefined();
    expect(calls[0]?.environment?.TRANSFORMERS_OFFLINE).toBeUndefined();
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({ state: "ready" });

    await subject.synthesize(request(), { scratchDir: await temporary("vidcom-scratch-") });
    expect(calls.at(-1)?.environment).toMatchObject({
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    });
  });

  it("automatically probes a warm cache offline after restart", async () => {
    const calls: ProcessRunInput[] = [];
    const { cache, subject } = await cachedProvider({}, calls);
    await cache.markReady(DOWNLOAD_CACHE_COMPONENTS.models);

    expect((await subject.describe()).available).toBe(true);
    expect(calls[0]?.environment).toMatchObject({
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    });
  });

  it("repairs a markerless-but-incomplete warm cache online in the same describe call", async () => {
    const calls: ProcessRunInput[] = [];
    const { cache, subject } = await cachedProvider({
      offlineProbe: { ready: false, gpu: false, voices: [] },
      offlineProbeStderr: "offline cache is empty",
    }, calls);
    await cache.markReady(DOWNLOAD_CACHE_COMPONENTS.models);

    expect((await subject.describe()).available).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.environment).toMatchObject({
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    });
    expect(calls[1]?.environment?.HF_HUB_OFFLINE).toBeUndefined();
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({ state: "ready" });
  });

  it("does not repair a broken warm cache online during an explicit offline run", async () => {
    const calls: ProcessRunInput[] = [];
    const { cache, subject } = await cachedProvider({
      offlineProbe: { ready: false, gpu: false, voices: [] },
      offlineProbeStderr: "offline cache is empty",
    }, calls, true);
    await cache.markReady(DOWNLOAD_CACHE_COMPONENTS.models);

    await expect(subject.describe()).rejects.toMatchObject({ code: ErrorCode.DownloadUnavailable });
    expect(calls).toHaveLength(1);
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadUnavailable,
    });
  });

  it("keeps a ready model marker when the warm sidecar command is missing", async () => {
    const { cache, subject } = await cachedProvider({ probe: "crash" });
    await cache.markReady(DOWNLOAD_CACHE_COMPONENTS.models);

    expect(await subject.describe()).toMatchObject({
      available: false,
      unavailableReason: "sidecar_missing",
    });
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({
      state: "ready",
    });
  });

  it("allows a partial model cache to resume online before switching offline", async () => {
    const calls: ProcessRunInput[] = [];
    const { cache, subject } = await cachedProvider({}, calls);
    await cache.markPartial(DOWNLOAD_CACHE_COMPONENTS.models);

    expect((await subject.describe()).available).toBe(true);
    expect(calls[0]?.environment?.HF_HUB_OFFLINE).toBeUndefined();
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({ state: "ready" });
  });

  it("fails a forced-offline first run without starting the sidecar", async () => {
    const calls: ProcessRunInput[] = [];
    const { subject } = await cachedProvider({}, calls, true);

    await expect(subject.describe()).rejects.toMatchObject({ code: ErrorCode.DownloadUnavailable });
    expect(calls).toEqual([]);
  });

  it("persists a coded TLS failure from the cold model probe", async () => {
    const { cache, subject } = await cachedProvider({
      probe: { ready: false, gpu: false },
      probeStderr: "CERTIFICATE_VERIFY_FAILED",
    });

    await expect(subject.describe()).rejects.toMatchObject({ code: ErrorCode.DownloadTlsUntrusted });
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadTlsUntrusted,
    });
  });

  it("persists download_unavailable when the model probe reports a timeout", async () => {
    const { cache, subject } = await cachedProvider({ probeTimedOut: true });

    await expect(subject.describe()).rejects.toMatchObject({ code: ErrorCode.DownloadUnavailable });
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadUnavailable,
    });
  });

  it("offers CPU only until the probe has allocated on a real GPU", async () => {
    const subject = await provider({ probe: { ready: true, gpu: false } });

    const described = await subject.describe();

    expect(described.available).toBe(true);
    expect(described.voices.every((voice) => voice.computeDevices.join() === "cpu")).toBe(true);
  });

  it("offers GPU once the probe reports a usable device", async () => {
    const subject = await provider({ probe: { ready: true, gpu: true } });

    const described = await subject.describe();

    expect(described.voices[0]?.computeDevices).toEqual(["cpu", "gpu"]);
  });

  it("reports itself unavailable when the sidecar cannot start at all", async () => {
    const subject = await provider({ probe: "crash" });

    const described = await subject.describe();

    expect(described).toMatchObject({ available: false, unavailableReason: "sidecar_missing" });
  });

  it("never lets a custom voice id through", async () => {
    const subject = await provider();

    expect((await subject.describe()).allowsCustomVoiceId).toBe(false);
  });

  it("passes the requested device and engine speaker name to the sidecar", async () => {
    const calls: ProcessRunInput[] = [];
    const subject = await described({}, calls);
    const scratchDir = await temporary("vidcom-scratch-");

    await subject.synthesize(request(), { scratchDir });

    const requestPath = calls.at(-1)!.command[calls.at(-1)!.command.indexOf("--request") + 1]!;
    expect(JSON.parse(await readFile(requestPath, "utf8"))).toMatchObject({
      device: "cpu",
      // The engine addresses voices by display name; the id is VidCom's own.
      voice: "Phạm Tuyên",
      modelId: "vieneu-v3-turbo",
    });
  });

  it("fails when the sidecar ran on a different device than it was asked to", async () => {
    const subject = await described({ probe: { ready: true, gpu: true }, effectiveDevice: "cpu" });
    const scratchDir = await temporary("vidcom-scratch-");

    // Silently downgrading to CPU produces a batch that succeeds ten times
    // slower with nothing in the logs to explain it.
    await expect(subject.synthesize(request({ computeDevice: "gpu" }), { scratchDir }))
      .rejects.toThrow(/ran on cpu/);
  });

  it("reports raw audio without word timings, since the engine has none", async () => {
    const subject = await described();
    const scratchDir = await temporary("vidcom-scratch-");

    const produced = await subject.synthesize(request(), { scratchDir });

    expect(produced).toHaveLength(1);
    expect(produced[0]?.words).toEqual([]);
    expect(produced[0]?.rateApplied).toBe(false);
    expect(produced[0]?.filePath).toBe(join(scratchDir, "intro.vieneu.wav"));
  });

  it("retries once after a failed run, which is what a truncated download looks like", async () => {
    const subject = await described({ failFirst: 1 });
    const scratchDir = await temporary("vidcom-scratch-");

    const produced = await subject.synthesize(request(), { scratchDir });

    expect(produced).toHaveLength(1);
  });

  it("surfaces the sidecar's own stderr after the last attempt", async () => {
    const subject = await described({ exitCode: 1, stderr: "CUDA out of memory" });
    const scratchDir = await temporary("vidcom-scratch-");

    await expect(subject.synthesize(request(), { scratchDir })).rejects.toThrow(/CUDA out of memory/);
  });

  it("reports itself unavailable when the sidecar command is not configured", async () => {
    const subject = new VieNeuTtsProvider({
      processes: fakeSidecar(),
      command: () => [],
      modelCacheRoot: await temporary("vidcom-models-"),
    });

    expect(await subject.describe()).toMatchObject({ available: false, unavailableReason: "sidecar_missing" });
  });

  it("rejects a voice that is not one of the engine's own speakers", async () => {
    const subject = await described();
    const scratchDir = await temporary("vidcom-scratch-");

    await expect(subject.synthesize(request({ voiceId: "someone-else" }), { scratchDir }))
      .rejects.toMatchObject({ code: ErrorCode.TtsVoiceNotSupported });
  });

  it("builds its voice catalog from the engine rather than a list of its own", async () => {
    const subject = await provider({ probe: { ready: true, gpu: false, voices: ["Trúc Ly", "Quang Sơn"] } });

    const catalog = await subject.describe();

    // A hard-coded list drifts the moment upstream adds a voice, and a name
    // VidCom offers but the engine rejects fails at synthesis.
    expect(catalog.voices.map((voice) => voice.label)).toEqual(["Trúc Ly", "Quang Sơn"]);
    expect(catalog.voices.map((voice) => voice.id)).toEqual(["vieneu-v3-truc-ly", "vieneu-v3-quang-son"]);
  });

  it("recommends the four shortlisted voices and lists them first", async () => {
    const subject = await provider({
      probe: {
        ready: true,
        gpu: false,
        voices: ["Trúc Ly", "Phạm Tuyên", "Quang Sơn", "Đoan Trang", "Minh Đức", "Ngọc Linh"],
      },
    });

    const catalog = await subject.describe();

    expect(catalog.voices.filter((voice) => voice.recommended).map((voice) => voice.id)).toEqual([
      "vieneu-v3-pham-tuyen",
      "vieneu-v3-doan-trang",
      "vieneu-v3-minh-duc",
      "vieneu-v3-ngoc-linh",
    ]);
    // Recommended first, engine order preserved inside each group, so a picker
    // that just renders the list gets the shortlist at the top for free.
    expect(catalog.voices.slice(4).map((voice) => voice.label)).toEqual(["Trúc Ly", "Quang Sơn"]);
  });

  it("does not conjure a recommended voice the installed engine does not offer", async () => {
    const subject = await provider({ probe: { ready: true, gpu: false, voices: ["Trúc Ly"] } });

    const catalog = await subject.describe();

    // The engine's own list stays authoritative: offering a name it would reject
    // turns a shortlist into a synthesis failure.
    expect(catalog.voices.map((voice) => voice.id)).toEqual(["vieneu-v3-truc-ly"]);
    expect(catalog.voices.every((voice) => !voice.recommended)).toBe(true);
  });

  it("is unavailable when the engine imports but offers no voice", async () => {
    const subject = await provider({ probe: { ready: true, gpu: false, voices: [] } });

    expect(await subject.describe()).toMatchObject({ available: false, unavailableReason: "sidecar_missing" });
  });

  it("records the model revision that produced the audio", async () => {
    const subject = await described();
    const scratchDir = await temporary("vidcom-scratch-");

    const produced = await subject.synthesize(request(), { scratchDir });

    expect(produced[0]?.metadata).toMatchObject({ modelRevision: "abc1234" });
  });

  it("refuses a response that does not say which model revision it used", async () => {
    const calls: ProcessRunInput[] = [];
    const processes = fakeSidecar({}, calls);
    const subject = new VieNeuTtsProvider({
      processes: {
        async run(input) {
          const output = await processes.run(input);
          const index = input.command.indexOf("--response");
          if (index >= 0) {
            const responsePath = input.command[index + 1]!;
            const parsed = JSON.parse(await readFile(responsePath, "utf8")) as Record<string, unknown>;
            delete parsed.modelRevision;
            await writeFile(responsePath, JSON.stringify(parsed), "utf8");
          }
          return output;
        },
      },
      command: () => ["python", "worker.py"],
      modelCacheRoot: await temporary("vidcom-models-"),
    });
    await subject.describe();
    const scratchDir = await temporary("vidcom-scratch-");

    // Without it a WAV cannot be traced back to the weights that made it.
    await expect(subject.synthesize(request(), { scratchDir })).rejects.toThrow(/model revision/);
  });
});
