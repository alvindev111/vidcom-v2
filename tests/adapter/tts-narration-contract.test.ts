import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TtsProviderDto } from "@vidcom/contracts";
import {
  NARRATION_EDGE_PAD_SECONDS,
  NodeProcessRunner,
  TtsRegistry,
  type RawCueAudio,
  type TtsProviderAdapter,
  type TtsProviderContext,
} from "@vidcom/adapter";
import type { TtsSynthesisRequest, TtsWordTiming } from "@vidcom/core";

const processes = new NodeProcessRunner();
const directories: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  directories.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * How each shipped engine hands its audio to the registry.
 *
 * The two differ in exactly the ways that make a fix verified against one a
 * regression in the other, which is the whole reason this file exists:
 *
 * | | container | level | word timings | applies rate itself |
 * |---|---|---|---|---|
 * | VieNeu | WAV 48 kHz | engine output, loud | none | no — registry runs `atempo` |
 * | ElevenLabs | MP3 44.1 kHz | quieter | character alignment | yes — server-side `speed` |
 *
 * The claims about timings and `rateApplied` are the adapters' own, verified
 * against the real adapters in `tts-vieneu.test.ts` and `tts-elevenlabs.test.ts`;
 * this file takes them as given and pins what the shared normalization must then
 * do with each shape.
 */
interface EngineProfile {
  name: string;
  /** Lossy, so the profile exercises a decode rather than a copy. */
  lossy: boolean;
  sampleRate: number;
  /** Peak level of the generated source, so the loudness assertions span a real spread. */
  sourceGainDb: number;
  rateApplied: boolean;
  reportsWords: boolean;
}

const PROFILES: readonly EngineProfile[] = [
  { name: "vieneu", lossy: false, sampleRate: 48_000, sourceGainDb: -6, rateApplied: false, reportsWords: false },
  { name: "elevenlabs", lossy: true, sampleRate: 44_100, sourceGainDb: -26, rateApplied: true, reportsWords: true },
];

/** Silence, then tone, then silence — the shape a cue arrives in, with dead air to trim. */
const LEADING_SILENCE_SECONDS = 0.4;
const TONE_SECONDS = 1.6;
const TRAILING_SILENCE_SECONDS = 0.4;

/**
 * A source file in the profile's container at the profile's level.
 *
 * Built with FFmpeg rather than checked in as a fixture: the point is that the
 * registry copes with a real encode of each container, and a committed MP3 would
 * have to be regenerated the moment either profile changed.
 */
async function encodeSource(profile: EngineProfile, scratchDir: string): Promise<string> {
  const codec: LossyCodec = profile.lossy
    // Only reached from a `describe.skipIf(!hasFfmpeg)` body, which is exactly the
    // condition under which a codec was resolved.
    ? LOSSY_CODEC ?? (() => { throw new Error("no lossy encoder was resolved"); })()
    : { args: ["-c:a", "pcm_s16le"], extension: "wav" };
  const path = join(scratchDir, `${profile.name}-source.${codec.extension}`);
  const rate = profile.sampleRate;
  const result = await processes.run({
    command: [
      "ffmpeg", "-y", "-v", "error",
      "-f", "lavfi", "-i", `anullsrc=r=${rate}:cl=mono:d=${LEADING_SILENCE_SECONDS}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}:duration=${TONE_SECONDS}`,
      "-f", "lavfi", "-i", `anullsrc=r=${rate}:cl=mono:d=${TRAILING_SILENCE_SECONDS}`,
      "-filter_complex", `[0:a][1:a][2:a]concat=n=3:v=0:a=1[joined];[joined]volume=${profile.sourceGainDb}dB[out]`,
      "-map", "[out]", "-ar", String(rate), "-ac", "1",
      ...codec.args, path,
    ],
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return path;
}

/**
 * The words an engine would report for this source, timed against its own
 * untrimmed output the way both real engines time theirs.
 *
 * Three of them, spanning the tone, rather than one: a single word cannot
 * distinguish "the timings were placed correctly" from "the timings were shifted
 * and then clamped back into range at the front", and the shift is the mistake
 * this fixture exists to catch.
 */
const SOURCE_WORDS: readonly TtsWordTiming[] = [0, 1, 2].map((index) => ({
  text: `tone-${index}`,
  startSeconds: LEADING_SILENCE_SECONDS + (TONE_SECONDS / 3) * index,
  endSeconds: LEADING_SILENCE_SECONDS + (TONE_SECONDS / 3) * (index + 1),
}));

/**
 * Stands in for one engine: copies its pre-encoded source into the registry's
 * scratch directory and reports what that engine reports.
 *
 * Substituting the engine and not the normalization is deliberate — the engines
 * are a Python sidecar with multi-gigabyte weights and a paid HTTP API, and the
 * behaviour under test belongs to the registry either way.
 */
class ProfileProvider implements TtsProviderAdapter {
  readonly id: string;

  constructor(private readonly profile: EngineProfile, private readonly sourcePath: string) {
    this.id = profile.name;
  }

  async describe(): Promise<TtsProviderDto> {
    return {
      id: this.id,
      label: this.profile.name,
      available: true,
      unavailableReason: null,
      voices: [{
        id: `${this.id}-voice`,
        providerId: this.id,
        label: "Voice",
        language: "vi",
        modelId: `${this.id}-1`,
        supportsEmotionCues: false,
        computeDevices: ["cpu"],
        recommended: true,
      }],
      allowsCustomVoiceId: false,
      customVoiceDefaults: null,
    };
  }

  async synthesize(
    request: TtsSynthesisRequest,
    context: TtsProviderContext,
  ): Promise<readonly RawCueAudio[]> {
    const { copyFile } = await import("node:fs/promises");
    const extension = this.sourcePath.slice(this.sourcePath.lastIndexOf(".") + 1);
    const produced: RawCueAudio[] = [];
    for (const cue of request.cues) {
      const filePath = join(context.scratchDir, `${cue.id}.${this.profile.name}.${extension}`);
      await copyFile(this.sourcePath, filePath);
      produced.push({
        cueId: cue.id,
        filePath,
        words: this.profile.reportsWords ? [...SOURCE_WORDS] : [],
        rateApplied: this.profile.rateApplied,
        metadata: { engine: this.profile.name },
      });
    }
    return produced;
  }
}

async function synthesizeThrough(
  profile: EngineProfile,
  overrides: Partial<TtsSynthesisRequest> = {},
) {
  const scratchDir = await scratch(`vidcom-contract-${profile.name}-`);
  const provider = new ProfileProvider(profile, await encodeSource(profile, scratchDir));
  const registry = new TtsRegistry({
    providers: [provider],
    processes,
    scratchRoot: await scratch("vidcom-contract-root-"),
  });

  const result = await registry.synthesize({
    cues: [{ id: "intro", text: "Xin chào" }],
    providerId: profile.name,
    voiceId: `${profile.name}-voice`,
    modelId: null,
    languageCode: "vi",
    ratePercent: 0,
    computeDevice: "cpu",
    seed: 1234,
    ...overrides,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const cue = result.value[0];
  if (!cue) throw new Error("the registry returned no cue");

  // The registry hands back bytes, not a path; the measurements below need a file.
  const publishedPath = join(scratchDir, `${profile.name}-published.wav`);
  await writeFile(publishedPath, cue.audio);
  return { cue, publishedPath };
}

/** Sample rate and channel count of a published cue. */
async function streamShape(path: string): Promise<string> {
  const probed = await processes.run({
    command: [
      "ffprobe", "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate,channels",
      "-of", "default=noprint_wrappers=1", path,
    ],
  });
  return probed.stdout;
}

/**
 * Peak level in dB over one window of a file, or `-Infinity` for pure silence.
 *
 * Peak rather than RMS: the pad assertions need to prove there is *nothing*
 * there, and a single stray sample is what a missing fade would leave behind.
 */
async function peakDb(path: string, from: number, to: number): Promise<number> {
  const measured = await processes.run({
    command: [
      "ffmpeg", "-hide_banner", "-nostats", "-v", "info",
      "-i", path,
      "-af", `atrim=start=${from.toFixed(3)}:end=${to.toFixed(3)},astats=measure_overall=Peak_level:measure_perchannel=none`,
      "-f", "null", "-",
    ],
  });
  const matched = /Peak level dB:\s*(-?[\d.]+|-?inf)/u.exec(measured.stderr);
  if (!matched?.[1]) throw new Error(`astats reported no peak level: ${measured.stderr}`);
  return matched[1].endsWith("inf") ? -Infinity : Number.parseFloat(matched[1]);
}

/** Integrated loudness of a published cue, read from loudnorm's own measurement pass. */
async function integratedLufs(path: string): Promise<number> {
  const measured = await processes.run({
    command: [
      "ffmpeg", "-hide_banner", "-nostats", "-v", "info",
      "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-",
    ],
  });
  // FFmpeg prints the muxing summary after the JSON, so the block has to be
  // bounded at both ends rather than sliced to the end of the log.
  const opened = measured.stderr.lastIndexOf("{");
  const closed = measured.stderr.lastIndexOf("}");
  const parsed = JSON.parse(measured.stderr.slice(opened, closed + 1)) as { input_i?: string };
  const value = Number.parseFloat(parsed.input_i ?? "");
  if (!Number.isFinite(value)) throw new Error(`loudnorm reported no integrated loudness: ${measured.stderr}`);
  return value;
}

interface LossyCodec {
  args: readonly string[];
  extension: string;
}

/**
 * The lossy encoder to build the cloud-engine fixture with.
 *
 * MP3 is what ElevenLabs actually returns, so it is preferred — but `libmp3lame`
 * is an optional FFmpeg dependency, and a build without it would otherwise skip
 * this whole file rather than run the half of it that does not care. The native
 * AAC encoder is always present and gives the property the profile is really
 * about: a lossy container the registry has to decode, at a sample rate and level
 * of its own. CI's image carries `libmp3lame`, so the real container is still
 * covered where it counts.
 */
async function resolveLossyCodec(): Promise<LossyCodec | null> {
  try {
    const [version, encoders] = await Promise.all([
      processes.run({ command: ["ffmpeg", "-version"], timeoutMs: 15_000 }),
      processes.run({ command: ["ffmpeg", "-hide_banner", "-encoders"], timeoutMs: 15_000 }),
    ]);
    if (version.exitCode !== 0) return null;
    if (encoders.stdout.includes("libmp3lame")) {
      return { args: ["-c:a", "libmp3lame", "-b:a", "128k"], extension: "mp3" };
    }
    if (/^\s*\S*A\S*\s+aac\s/mu.test(encoders.stdout)) {
      process.stderr.write("tts-narration-contract: no libmp3lame, using the native AAC encoder\n");
      return { args: ["-c:a", "aac", "-b:a", "128k"], extension: "m4a" };
    }
    return null;
  } catch { return null; }
}

const LOSSY_CODEC = await resolveLossyCodec();
const hasFfmpeg = LOSSY_CODEC !== null;
if (!hasFfmpeg) {
  // A skipped audio test reads exactly like a passing one in CI output, which is
  // how the narration pipeline went unverified before. CI sets the flag so a
  // missing toolchain fails there and merely skips locally.
  if (process.env.VIDCOM_REQUIRE_FFMPEG) {
    throw new Error(
      "VIDCOM_REQUIRE_FFMPEG is set but no usable ffmpeg is on PATH; "
      + "the cross-engine narration contract cannot be verified without it",
    );
  }
  process.stderr.write("SKIPPING tts-narration-contract: ffmpeg is not on PATH\n");
}

/** -16 LUFS is the target the registry normalizes to; ±1.5 LU covers gating noise on a 2 s cue. */
const TARGET_LUFS = -16;
const LOUDNESS_TOLERANCE_LU = 1.5;

describe.skipIf(!hasFfmpeg)("narration audio contract, per engine", () => {
  describe.each(PROFILES)("$name", (profile) => {
    it("lands on WAV 44.1 kHz mono whatever the engine produced", async () => {
      const { publishedPath } = await synthesizeThrough(profile);

      const shape = await streamShape(publishedPath);
      expect(shape).toContain("sample_rate=44100");
      expect(shape).toContain("channels=1");
    });

    it("reports a duration that matches the audio it published", async () => {
      const { cue, publishedPath } = await synthesizeThrough(profile);

      const probed = await processes.run({
        command: [
          "ffprobe", "-v", "error", "-select_streams", "a:0",
          "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
          publishedPath,
        ],
      });
      expect(cue.durationSeconds).toBeCloseTo(Number.parseFloat(probed.stdout.trim()), 1);
    });

    it("keeps a breath of silence at both ends so cues do not butt together", async () => {
      const { cue, publishedPath } = await synthesizeThrough(profile);

      // A window fully inside the pad: silent, and silent all the way to the edge
      // — a hard cut without the fade leaves a click right at the boundary.
      const window = NARRATION_EDGE_PAD_SECONDS * 0.7;
      expect(await peakDb(publishedPath, 0, window)).toBeLessThan(-60);
      expect(await peakDb(publishedPath, cue.durationSeconds - window, cue.durationSeconds))
        .toBeLessThan(-60);
      // And the speech itself is still there between the pads.
      expect(await peakDb(publishedPath, cue.durationSeconds / 2, cue.durationSeconds / 2 + 0.1))
        .toBeGreaterThan(-30);
    });

    it("normalizes loudness to the shared target regardless of the engine's level", async () => {
      const { publishedPath } = await synthesizeThrough(profile);

      // The two profiles arrive 20 dB apart. Landing both on the same target is
      // what stops a scene change from sounding like a different speaker.
      expect(Math.abs(await integratedLufs(publishedPath) - TARGET_LUFS))
        .toBeLessThan(LOUDNESS_TOLERANCE_LU);
    });

    it("pads by the same amount whether or not the registry applied the rate", async () => {
      const plain = await synthesizeThrough(profile);
      const faster = await synthesizeThrough(profile, { ratePercent: 20 });

      // atempo runs before the pad, so speeding a cue up shortens the speech and
      // leaves the breathing room untouched. Putting the pad first would scale it
      // too, and the gap between cues would depend on the narration rate.
      for (const { cue } of [plain, faster]) {
        expect(cue.durationSeconds - cue.speechDurationSeconds)
          .toBeCloseTo(2 * NARRATION_EDGE_PAD_SECONDS, 2);
        expect(cue.speechStartSeconds).toBeCloseTo(NARRATION_EDGE_PAD_SECONDS, 3);
      }
      if (profile.rateApplied) {
        // The engine already applied it, so the registry must not apply it twice.
        expect(faster.cue.speechDurationSeconds).toBeCloseTo(plain.cue.speechDurationSeconds, 1);
      } else {
        expect(faster.cue.speechDurationSeconds).toBeLessThan(plain.cue.speechDurationSeconds);
      }
    });

    it("keeps word timings on the speech, when the engine reports any", async () => {
      const { cue } = await synthesizeThrough(profile);

      if (!profile.reportsWords) {
        expect(cue.words).toEqual([]);
        return;
      }
      const first = cue.words[0];
      const last = cue.words.at(-1);
      expect(cue.words).toHaveLength(SOURCE_WORDS.length);
      if (!first || !last) return;

      const speechEndSeconds = cue.speechStartSeconds + cue.speechDurationSeconds;
      // The engine timed these against its own untrimmed output, where the first
      // began at 0.4 s. Normalization removes that dead air and then puts the pad
      // back, so the words have to end up spanning the speech: the last one
      // reaching its end is what a forgotten pad breaks, and it cannot be masked
      // by the range clamp the way the first word's start can.
      expect(speechEndSeconds - last.endSeconds).toBeLessThan(0.1);
      expect(last.endSeconds).toBeLessThanOrEqual(speechEndSeconds);
      // And nothing sits in the leading pad, where there is only silence.
      expect(first.startSeconds).toBeGreaterThanOrEqual(cue.speechStartSeconds);
      expect(first.startSeconds - cue.speechStartSeconds).toBeLessThan(0.1);
      for (const [index, word] of cue.words.entries()) {
        expect(word.endSeconds).toBeGreaterThan(word.startSeconds);
        expect(word.endSeconds).toBeLessThanOrEqual(cue.durationSeconds);
        if (index > 0) expect(word.startSeconds).toBeGreaterThanOrEqual(cue.words[index - 1]!.endSeconds);
      }
    });
  });

  it("puts every engine on the same level as every other", async () => {
    const measured = await Promise.all(PROFILES.map(async (profile) => {
      const { publishedPath } = await synthesizeThrough(profile);
      return integratedLufs(publishedPath);
    }));

    // The assertion the per-engine tests cannot make: a listener crossing a scene
    // boundary hears one voice, not two engines each normalized to its own idea
    // of loud.
    expect(Math.max(...measured) - Math.min(...measured)).toBeLessThan(LOUDNESS_TOLERANCE_LU);
  });
});
