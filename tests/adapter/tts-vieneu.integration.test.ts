import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  defaultVieNeuCommand,
  NodeProcessRunner,
  probeDuration,
  readVidcomSettings,
  TtsRegistry,
  VieNeuTtsProvider,
} from "@vidcom/adapter";
import type { TtsSynthesisRequest } from "@vidcom/core";

/**
 * Drives the real VieNeu engine end to end: the Python sidecar, the model weights
 * it downloads, and the FFmpeg normalisation that follows.
 *
 * Opt-in via `VIDCOM_VIENEU_REAL=1`, because it needs an installed engine and a
 * one-time model download that CI deliberately does not pay for. Every other
 * aspect of this provider is covered by `tts-vieneu.test.ts` against a fake
 * process — which is exactly why this file has to exist: a fake process cannot
 * catch a wrong SDK call, and a wrong SDK call is the defect that shipped the
 * first time this provider was written.
 *
 * The sidecar command comes from `VIDCOM_VIENEU_COMMAND` as a JSON array, else
 * `tts.vieneu.command` in `~/.vidcom/setting.json`, else the shipped worker under
 * the platform interpreter.
 */
const enabled = process.env.VIDCOM_VIENEU_REAL === "1";
if (!enabled) {
  process.stderr.write(
    "SKIPPING tts-vieneu.integration: set VIDCOM_VIENEU_REAL=1 with the engine installed\n",
  );
}

/** 25 minutes: the first run resolves and downloads the model before it speaks a word. */
const REAL_RUN_TIMEOUT_MS = 25 * 60 * 1_000;

const roots: string[] = [];
const processes = new NodeProcessRunner();
let command: readonly string[] = [];
let modelCacheRoot = "";

async function temporary(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  roots.push(created);
  return created;
}

async function resolveCommand(): Promise<readonly string[]> {
  const fromEnvironment = process.env.VIDCOM_VIENEU_COMMAND;
  if (fromEnvironment) {
    const parsed: unknown = JSON.parse(fromEnvironment);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new TypeError("VIDCOM_VIENEU_COMMAND must be a non-empty JSON array");
    }
    return parsed as string[];
  }
  const settings = await readVidcomSettings();
  return settings.tts.vieneu.command ?? defaultVieNeuCommand();
}

function provider(): VieNeuTtsProvider {
  return new VieNeuTtsProvider({ processes, command: () => command, modelCacheRoot });
}

function request(voiceId: string): TtsSynthesisRequest {
  return {
    cues: [{ id: "intro", text: "Xin chào, đây là VidCom kiểm tra giọng đọc tiếng Việt." }],
    providerId: "vieneu",
    voiceId,
    modelId: "vieneu-v3-turbo",
    languageCode: "vi",
    ratePercent: 0,
    computeDevice: "cpu",
  };
}

beforeAll(async () => {
  if (!enabled) return;
  command = await resolveCommand();
  // One cache for the whole file: re-downloading the model per test would make
  // this unusable, and the cache is the expensive part.
  modelCacheRoot = process.env.VIDCOM_VIENEU_MODEL_CACHE
    ? process.env.VIDCOM_VIENEU_MODEL_CACHE
    : await temporary("vidcom-real-models-");
}, REAL_RUN_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("VieNeu against the real engine", () => {
  it("reports itself available with the engine's own voice list", async () => {
    const described = await provider().describe();

    expect(described).toMatchObject({ id: "vieneu", available: true, unavailableReason: null });
    expect(described.voices.length).toBeGreaterThan(0);
    // Every id VidCom offers has to be one the engine would accept, so the whole
    // catalog is derived from `list_preset_voices()` rather than kept in TypeScript.
    for (const voice of described.voices) {
      expect(voice.id).toMatch(/^vieneu-v3-[a-z0-9-]+$/);
      expect(voice.computeDevices).toContain("cpu");
    }
    process.stderr.write(`engine voices: ${described.voices.map((v) => v.id).join(", ")}\n`);
  }, REAL_RUN_TIMEOUT_MS);

  it("speaks a Vietnamese cue and normalises it to 44.1 kHz mono WAV", async () => {
    const described = await provider().describe();
    const voice = described.voices.find((candidate) => candidate.recommended) ?? described.voices[0];
    if (!voice) throw new Error("the engine reported no voices to synthesize with");

    // Through the registry, not the provider alone: this is the path production
    // takes, so FFmpeg normalisation and duration probing are exercised too.
    const registry = new TtsRegistry({
      processes,
      scratchRoot: await temporary("vidcom-real-scratch-"),
      providers: [provider()],
    });

    const result = await registry.synthesize(request(voice.id));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    const [cue] = result.value;
    expect(cue?.cueId).toBe("intro");
    // A sentence this length cannot be under a second of speech; the upper bound
    // catches audio that was never trimmed.
    expect(cue!.durationSeconds).toBeGreaterThan(1);
    expect(cue!.durationSeconds).toBeLessThan(20);
    expect(cue!.metadata).toMatchObject({ provider: "vieneu", effectiveDevice: "cpu", sampleRate: 44_100 });
    expect(typeof cue!.metadata.modelRevision).toBe("string");
    // VieNeu reports no alignment; the estimate is applied by the use case, not here.
    expect(cue!.words).toEqual([]);

    const audioPath = join(await temporary("vidcom-real-audio-"), "intro.wav");
    await writeFile(audioPath, cue!.audio);
    expect(await probeDuration(processes, audioPath)).toBeCloseTo(cue!.durationSeconds, 1);
    process.stderr.write(
      `synthesized ${cue!.durationSeconds}s with ${voice.id} (${String(cue!.metadata.modelRevision)})\n`,
    );
  }, REAL_RUN_TIMEOUT_MS);

  it("refuses a GPU request unless the engine actually found one", async () => {
    const described = await provider().describe();
    const voice = described.voices[0];
    if (!voice) throw new Error("the engine reported no voices");
    const registry = new TtsRegistry({
      processes,
      scratchRoot: await temporary("vidcom-real-scratch-"),
      providers: [provider()],
    });

    const result = await registry.synthesize({ ...request(voice.id), computeDevice: "gpu" });

    // On a CPU-only install this must fail rather than quietly run on CPU; on a
    // machine with a working CUDA device it is allowed to succeed.
    if (voice.computeDevices.includes("gpu")) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/GPU/i);
    }
  }, REAL_RUN_TIMEOUT_MS);
});
