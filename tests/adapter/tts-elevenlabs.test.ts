import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import { ElevenLabsTtsProvider } from "@vidcom/adapter";
import type { TtsSynthesisRequest } from "@vidcom/core";

const directories: string[] = [];

async function scratch(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "vidcom-11labs-"));
  directories.push(created);
  return created;
}

// The provider imports the SDK on first use rather than at module scope, so
// whichever test synthesized first would otherwise pay the module-load cost
// inside its own timeout — which under the full suite exceeded it. One throwaway
// synthesis warms it in a hook, so each test measures the adapter rather than npm
// resolution. It has to go through the provider: the SDK is a dependency of
// `packages/adapter`, so this file cannot import it directly.
beforeAll(async () => {
  const subject = new ElevenLabsTtsProvider({ apiKey: "warm", fetch: respondWith(audioResponse("hi")) });
  await subject.synthesize(request(), { scratchDir: await scratch() });
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Character-level alignment in the shape the API returns it. */
function alignment(text: string, secondsPerCharacter = 0.1) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_character, index) => index * secondsPerCharacter),
    character_end_times_seconds: characters.map((_character, index) => (index + 1) * secondsPerCharacter),
  };
}

function respondWith(body: unknown, status = 200): typeof globalThis.fetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function audioResponse(text: string) {
  return {
    audio_base64: Buffer.alloc(1_024, 9).toString("base64"),
    alignment: alignment(text),
    normalized_alignment: alignment(text),
  };
}

function request(overrides: Partial<TtsSynthesisRequest> = {}): TtsSynthesisRequest {
  return {
    cues: [{ id: "intro", text: "hi there" }],
    providerId: "elevenlabs",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    modelId: "eleven_v3",
    languageCode: "vi",
    ratePercent: 0,
    computeDevice: "cpu",
    ...overrides,
  };
}

describe("ElevenLabsTtsProvider", () => {
  it("stays in the catalog without a key, so the UI can say what is missing", async () => {
    const described = await new ElevenLabsTtsProvider({ apiKey: null }).describe();

    expect(described).toMatchObject({ available: false, unavailableReason: "credential_missing" });
    expect(described.voices.length).toBeGreaterThan(0);
  });

  it("accepts cloned voice ids that no shipped catalog could list", async () => {
    const described = await new ElevenLabsTtsProvider({ apiKey: "k" }).describe();

    expect(described.allowsCustomVoiceId).toBe(true);
    expect(described.customVoiceDefaults).toMatchObject({ supportsEmotionCues: true, computeDevices: ["cpu"] });
  });

  it("offers CPU only — the engine is remote and has no local device to pick", async () => {
    const described = await new ElevenLabsTtsProvider({ apiKey: "k" }).describe();

    expect(described.voices.every((voice) => voice.computeDevices.join() === "cpu")).toBe(true);
  });

  it("writes the returned audio and folds alignment into word timings", async () => {
    const subject = new ElevenLabsTtsProvider({ apiKey: "k", fetch: respondWith(audioResponse("hi there")) });
    const scratchDir = await scratch();

    const produced = await subject.synthesize(request(), { scratchDir });

    expect(produced).toHaveLength(1);
    expect((await readFile(produced[0]!.filePath)).byteLength).toBe(1_024);
    expect(produced[0]?.words.map((word) => word.text)).toEqual(["hi", "there"]);
    expect(produced[0]?.words[0]).toMatchObject({ startSeconds: 0, endSeconds: 0.2 });
  });

  it("reports the rate as already applied, since v3 takes a speed parameter", async () => {
    const subject = new ElevenLabsTtsProvider({ apiKey: "k", fetch: respondWith(audioResponse("hi")) });
    const scratchDir = await scratch();

    const produced = await subject.synthesize(request({ ratePercent: 10 }), { scratchDir });

    // Re-applying atempo on top would compound the two and roughly square it.
    expect(produced[0]?.rateApplied).toBe(true);
  });

  it("drops audio tags from word timings, because the model does not speak them", async () => {
    const spoken = "[laughs] hi";
    const subject = new ElevenLabsTtsProvider({ apiKey: "k", fetch: respondWith(audioResponse(spoken)) });
    const scratchDir = await scratch();

    const produced = await subject.synthesize(request({
      cues: [{ id: "intro", text: "[cười] hi" }],
    }), { scratchDir });

    expect(produced[0]?.words.map((word) => word.text)).toEqual(["hi"]);
  });

  it("returns no word timings rather than half-correct ones", async () => {
    const broken = { ...audioResponse("hi"), alignment: { ...alignment("hi"), character_end_times_seconds: [0.1] } };
    const subject = new ElevenLabsTtsProvider({ apiKey: "k", fetch: respondWith(broken) });
    const scratchDir = await scratch();

    const produced = await subject.synthesize(request(), { scratchDir });

    expect(produced[0]?.words).toEqual([]);
  });

  it("rejects an empty generation instead of publishing silence", async () => {
    const subject = new ElevenLabsTtsProvider({
      apiKey: "k",
      fetch: respondWith({ audio_base64: "", alignment: null, normalized_alignment: null }),
    });
    const scratchDir = await scratch();

    await expect(subject.synthesize(request(), { scratchDir })).rejects.toThrow(/no usable audio/);
  });

  it("names a missing key as a credential problem", async () => {
    const subject = new ElevenLabsTtsProvider({ apiKey: "  " });
    const scratchDir = await scratch();

    await expect(subject.synthesize(request(), { scratchDir }))
      .rejects.toMatchObject({ code: ErrorCode.TtsCredentialMissing });
  });

  it.each([
    [401, ErrorCode.TtsCredentialMissing],
    [403, ErrorCode.TtsCredentialMissing],
    [402, ErrorCode.TtsQuotaExceeded],
    [429, ErrorCode.TtsQuotaExceeded],
    [500, ErrorCode.TtsSynthesisFailed],
  ])("maps HTTP %i onto %s", async (status, code) => {
    const subject = new ElevenLabsTtsProvider({
      apiKey: "k",
      fetch: respondWith({ detail: "nope" }, status),
    });
    const scratchDir = await scratch();

    await expect(subject.synthesize(request(), { scratchDir })).rejects.toMatchObject({ code });
  });
});
