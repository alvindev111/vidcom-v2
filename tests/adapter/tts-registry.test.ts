import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode, type TtsProviderDto } from "@vidcom/contracts";
import { TtsRegistry, TtsProviderError, type RawCueAudio, type TtsProviderAdapter } from "@vidcom/adapter";
import type { ProcessPort, ProcessRunInput, TtsSynthesisRequest } from "@vidcom/core";

const scratchRoots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vidcom-tts-"));
  scratchRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Stands in for FFmpeg: answers the preflight, copies sources through, reports a fixed duration. */
function fakeProcesses(commands: ProcessRunInput[] = [], options: { toolchain?: boolean } = {}): ProcessPort {
  return {
    async run(input) {
      commands.push(input);
      if (input.command[1] === "-version") {
        if (options.toolchain === false) throw new Error("spawn ENOENT");
        return { exitCode: 0, stdout: `${input.command[0]} version 7.0`, stderr: "", timedOut: false };
      }
      if (input.command[0] === "ffmpeg") {
        const target = input.command.at(-1);
        if (target) await writeFile(target, Buffer.alloc(2_048, 7));
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "3.250\n", stderr: "", timedOut: false };
    },
  };
}

/** The pipeline ffmpeg invocation, not the `-version` preflight that precedes it. */
function conversionCommand(commands: readonly ProcessRunInput[]): readonly string[] | undefined {
  return commands.find((command) => command.command[0] === "ffmpeg" && command.command[1] !== "-version")?.command;
}

function description(overrides: Partial<TtsProviderDto> = {}): TtsProviderDto {
  return {
    id: "fake",
    label: "Fake engine",
    available: true,
    unavailableReason: null,
    voices: [{
      id: "fake-voice",
      providerId: "fake",
      label: "Fake voice",
      language: "vi",
      modelId: "fake-1",
      supportsEmotionCues: false,
      computeDevices: ["cpu"],
      recommended: true,
    }],
    allowsCustomVoiceId: false,
    customVoiceDefaults: null,
    ...overrides,
  };
}

class FakeProvider implements TtsProviderAdapter {
  readonly id: string;
  calls = 0;
  active = 0;
  maxConcurrent = 0;
  lastRequest: TtsSynthesisRequest | null = null;

  constructor(
    private readonly options: {
      id?: string;
      describe?: TtsProviderDto;
      onSynthesize?: () => Promise<void>;
      fail?: Error;
      skipCue?: string;
      words?: RawCueAudio["words"];
    } = {},
  ) {
    this.id = options.id ?? "fake";
  }

  async describe(): Promise<TtsProviderDto> {
    this.calls += 1;
    return this.options.describe ?? description({ id: this.id });
  }

  async synthesize(request: TtsSynthesisRequest, context: { scratchDir: string }): Promise<readonly RawCueAudio[]> {
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    this.lastRequest = request;
    try {
      await this.options.onSynthesize?.();
      if (this.options.fail) throw this.options.fail;
      const produced: RawCueAudio[] = [];
      for (const cue of request.cues) {
        if (cue.id === this.options.skipCue) continue;
        const filePath = join(context.scratchDir, `${cue.id}.raw.wav`);
        await writeFile(filePath, Buffer.alloc(2_048, 3));
        produced.push({
          cueId: cue.id,
          filePath,
          words: this.options.words ?? [],
          rateApplied: false,
          metadata: { engine: this.id },
        });
      }
      return produced;
    } finally {
      this.active -= 1;
    }
  }
}

async function registry(providers: TtsProviderAdapter[], processes = fakeProcesses()) {
  return new TtsRegistry({ providers, processes, scratchRoot: await scratchRoot() });
}

const REQUEST: TtsSynthesisRequest = {
  cues: [{ id: "intro", text: "Xin chào" }],
  providerId: "fake",
  voiceId: "fake-voice",
  modelId: null,
  languageCode: "vi",
  ratePercent: 0,
  computeDevice: "cpu",
};

describe("TtsRegistry", () => {
  it("refuses two providers claiming the same id", async () => {
    const root = await scratchRoot();
    expect(() => new TtsRegistry({
      providers: [new FakeProvider(), new FakeProvider()],
      processes: fakeProcesses(),
      scratchRoot: root,
    })).toThrow(TypeError);
  });

  it("normalizes every provider's output to measured WAV bytes", async () => {
    const commands: ProcessRunInput[] = [];
    const subject = await registry([new FakeProvider()], fakeProcesses(commands));

    const result = await subject.synthesize(REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.durationSeconds).toBe(3.25);
    expect(result.value[0]?.audio.byteLength).toBe(2_048);
    expect(result.value[0]?.metadata).toMatchObject({
      engine: "fake",
      provider: "fake",
      computeDevice: "cpu",
      sampleRate: 44_100,
    });
    const ffmpeg = conversionCommand(commands);
    expect(ffmpeg).toContain("44100");
    expect(ffmpeg).toContain("-ac");
  });

  it("applies the rate itself only when the engine did not", async () => {
    const commands: ProcessRunInput[] = [];
    const subject = await registry([new FakeProvider()], fakeProcesses(commands));

    await subject.synthesize({ ...REQUEST, ratePercent: 10 });

    expect(conversionCommand(commands)?.join(" ")).toContain("atempo=1.100");
  });

  it("reports every provider unavailable when FFmpeg is missing", async () => {
    const subject = await registry([new FakeProvider()], fakeProcesses([], { toolchain: false }));

    const [described] = await subject.listProviders();

    // Normalization is the registry's own dependency, so no engine can succeed
    // without it — and a cloud engine reported as available would bill the user
    // for audio that is then thrown away.
    expect(described).toMatchObject({ available: false, unavailableReason: "audio_toolchain_missing" });
  });

  it("refuses to call an engine at all when FFmpeg is missing", async () => {
    const provider = new FakeProvider();
    const subject = await registry([provider], fakeProcesses([], { toolchain: false }));

    const result = await subject.synthesize(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsProviderUnavailable);
    expect(result.error.message).toContain("FFmpeg");
    expect(provider.active).toBe(0);
    expect(provider.maxConcurrent).toBe(0);
  });

  it("moves engine word timings onto the trimmed audio", async () => {
    const commands: ProcessRunInput[] = [];
    // Source runs 3.25s with 0.5s of leading silence trimmed away; a word the
    // engine put at 0.5 belongs at 0 once that padding is gone.
    const processes: ProcessPort = {
      async run(input) {
        commands.push(input);
        if (input.command[1] === "-version") {
          return { exitCode: 0, stdout: "7.0", stderr: "", timedOut: false };
        }
        if (input.command[0] === "ffmpeg") {
          const target = input.command.at(-1);
          if (target) await writeFile(target, Buffer.alloc(2_048, 7));
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        }
        const target = input.command.at(-1) ?? "";
        if (target.endsWith(".raw.wav")) return { exitCode: 0, stdout: "3.750\n", stderr: "", timedOut: false };
        if (target.endsWith(".leading.wav")) return { exitCode: 0, stdout: "3.250\n", stderr: "", timedOut: false };
        return { exitCode: 0, stdout: "3.250\n", stderr: "", timedOut: false };
      },
    };
    const subject = await registry([new FakeProvider({
      words: [{ text: "xin", startSeconds: 0.5, endSeconds: 1 }, { text: "chào", startSeconds: 1, endSeconds: 1.5 }],
    })], processes);

    const result = await subject.synthesize(REQUEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.words[0]?.startSeconds).toBe(0);
    expect(result.value[0]?.metadata).toMatchObject({ trimStartSeconds: 0.5 });
  });

  it("skips the extra trim measurement when the engine reported no timings", async () => {
    const commands: ProcessRunInput[] = [];
    const subject = await registry([new FakeProvider()], fakeProcesses(commands));

    await subject.synthesize(REQUEST);

    expect(commands.some((command) => command.command.at(-1)?.endsWith(".leading.wav"))).toBe(false);
  });

  it("rejects a voice that does not belong to the engine", async () => {
    const subject = await registry([new FakeProvider()]);

    const result = await subject.synthesize({ ...REQUEST, voiceId: "someone-else" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsVoiceNotSupported);
  });

  it("accepts an unlisted voice id when the engine allows cloned voices", async () => {
    const subject = await registry([new FakeProvider({
      describe: description({ allowsCustomVoiceId: true, customVoiceDefaults: {
        modelId: "fake-1", supportsEmotionCues: true, computeDevices: ["cpu"],
      } }),
    })]);

    const result = await subject.synthesize({ ...REQUEST, voiceId: "cloned-abc123" });

    expect(result.ok).toBe(true);
  });

  it("rejects a GPU request the engine has not advertised", async () => {
    const subject = await registry([new FakeProvider()]);

    const result = await subject.synthesize({ ...REQUEST, computeDevice: "gpu" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Falling back to CPU here is the failure mode the device policy exists to
    // prevent: the batch would succeed, ten times slower, silently.
    expect(result.error.code).toBe(ErrorCode.TtsProviderUnavailable);
    expect(result.error.message).toContain("no usable GPU");
  });

  it("reports a missing credential as such rather than as a synthesis failure", async () => {
    const subject = await registry([new FakeProvider({
      describe: description({ available: false, unavailableReason: "credential_missing" }),
    })]);

    const result = await subject.synthesize(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsCredentialMissing);
  });

  it("rejects an emotion cue the selected voice cannot act", async () => {
    const subject = await registry([new FakeProvider()]);

    const result = await subject.synthesize({
      ...REQUEST, cues: [{ id: "intro", text: "Thật là [cười] vui" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsVoiceNotSupported);
    expect(result.error.details).toMatchObject({ sceneId: "intro" });
  });

  it("resolves pause cues before the engine sees the text", async () => {
    const provider = new FakeProvider();
    const subject = await registry([provider]);

    await subject.synthesize({ ...REQUEST, cues: [{ id: "intro", text: "Một [ngắt ngắn] hai" }] });

    expect(provider.lastRequest?.cues[0]?.text).toBe("Một, hai");
  });

  it("rejects a scene id that could escape the scratch directory", async () => {
    const subject = await registry([new FakeProvider()]);

    const result = await subject.synthesize({ ...REQUEST, cues: [{ id: "../escape", text: "hi" }] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.SchemaInvalid);
  });

  it("fails the batch when the engine silently skips a cue", async () => {
    const subject = await registry([new FakeProvider({ skipCue: "outro" })]);

    const result = await subject.synthesize({
      ...REQUEST, cues: [{ id: "intro", text: "a" }, { id: "outro", text: "b" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsSynthesisFailed);
  });

  it("maps an unknown provider id to an actionable error", async () => {
    const subject = await registry([new FakeProvider()]);

    const result = await subject.synthesize({ ...REQUEST, providerId: "nope" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsProviderUnavailable);
  });

  it("preserves the engine's own error code", async () => {
    const subject = await registry([new FakeProvider({
      fail: new TtsProviderError("out of credit", ErrorCode.TtsQuotaExceeded),
    })]);

    const result = await subject.synthesize(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TtsQuotaExceeded);
  });

  it("removes the scratch directory whether the batch succeeded or failed", async () => {
    const root = await scratchRoot();
    const processes = fakeProcesses();
    const ok = new TtsRegistry({ providers: [new FakeProvider()], processes, scratchRoot: root });
    await ok.synthesize(REQUEST);
    const failing = new TtsRegistry({
      providers: [new FakeProvider({ fail: new TtsProviderError("boom") })],
      processes,
      scratchRoot: root,
    });
    await failing.synthesize(REQUEST);

    expect(await readdir(root)).toEqual([]);
  });

  it("serializes batches per provider so a local model never loads twice at once", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = new FakeProvider({ onSynthesize: () => gate });
    const subject = await registry([provider]);

    const first = subject.synthesize(REQUEST);
    const second = subject.synthesize(REQUEST);
    release();
    await Promise.all([first, second]);

    expect(provider.maxConcurrent).toBe(1);
  });

  it("describes each provider once and reuses the result", async () => {
    const provider = new FakeProvider();
    const subject = await registry([provider]);

    await subject.listProviders();
    await subject.listProviders();
    await subject.synthesize(REQUEST);

    expect(provider.calls).toBe(1);
  });
});
