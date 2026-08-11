import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NARRATION_EDGE_PAD_SECONDS,
  NodeProcessRunner,
  normalizeCueAudio,
  probeDuration,
} from "@vidcom/adapter";

const processes = new NodeProcessRunner();
const directories: string[] = [];

async function scratch(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "vidcom-ffmpeg-"));
  directories.push(created);
  return created;
}

/** Two seconds of tone padded with silence, so the trim has something to remove. */
async function toneWithSilence(
  scratchDir: string,
  options: { gainDb?: number; name?: string } = {},
): Promise<string> {
  const path = join(scratchDir, `${options.name ?? "source"}.wav`);
  const gain = options.gainDb ?? 0;
  const result = await processes.run({
    command: [
      "ffmpeg", "-y", "-v", "error",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.5",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.5",
      "-filter_complex", `[0:a][1:a][2:a]concat=n=3:v=0:a=1[joined];[joined]volume=${gain}dB[out]`,
      "-map", "[out]", "-ar", "48000", "-ac", "2", path,
    ],
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return path;
}

/** Integrated loudness of a file, read from loudnorm's own measurement pass. */
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

async function ffmpegAvailable(): Promise<boolean> {
  try {
    const version = await processes.run({ command: ["ffmpeg", "-version"], timeoutMs: 15_000 });
    return version.exitCode === 0;
  } catch { return false; }
}

const hasFfmpeg = await ffmpegAvailable();
if (!hasFfmpeg) {
  // A skipped audio pipeline test looks identical to a passing one in CI output,
  // which is exactly how this suite went unverified for several rounds. CI sets
  // the flag so a missing toolchain is a failure there and a skip locally.
  if (process.env.VIDCOM_REQUIRE_FFMPEG) {
    throw new Error(
      "VIDCOM_REQUIRE_FFMPEG is set but ffmpeg/ffprobe are not on PATH; "
      + "the narration audio pipeline cannot be verified without them",
    );
  }
  process.stderr.write("SKIPPING tts-audio-normalize: ffmpeg is not on PATH\n");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!hasFfmpeg)("normalizeCueAudio", () => {
  it("rewrites any input as trimmed 44.1 kHz mono WAV", async () => {
    const scratchDir = await scratch();
    const sourcePath = await toneWithSilence(scratchDir);

    const normalized = await normalizeCueAudio(processes, {
      sourcePath, scratchDir, cueId: "intro", ratePercent: 0,
    });

    const probed = await processes.run({
      command: [
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels",
        "-of", "default=noprint_wrappers=1", normalized.path,
      ],
    });
    expect(probed.stdout).toContain("sample_rate=44100");
    expect(probed.stdout).toContain("channels=1");
    expect((await stat(normalized.path)).size).toBeGreaterThan(1_024);
  });

  it("trims the engine's dead air and reports the speech apart from the pad", async () => {
    const scratchDir = await scratch();
    const sourcePath = await toneWithSilence(scratchDir);

    const normalized = await normalizeCueAudio(processes, {
      sourcePath, scratchDir, cueId: "intro", ratePercent: 0,
    });

    // Source is 3s: 0.5s silence, 2s tone, 0.5s silence. The engine's own silence
    // goes, and a known pad replaces it at both ends.
    expect(normalized.speechDurationSeconds).toBeGreaterThan(1.8);
    expect(normalized.speechDurationSeconds).toBeLessThan(2.2);
    expect(normalized.durationSeconds)
      .toBeCloseTo(normalized.speechDurationSeconds + 2 * NARRATION_EDGE_PAD_SECONDS, 2);
    expect(normalized.leadPadSeconds).toBe(NARRATION_EDGE_PAD_SECONDS);
  });

  it("speeds the speech up by the requested rate without shrinking the pad", async () => {
    const scratchDir = await scratch();
    const sourcePath = await toneWithSilence(scratchDir);

    const normalized = await normalizeCueAudio(processes, {
      sourcePath, scratchDir, cueId: "fast", ratePercent: 20,
    });

    // 2s of tone at 1.2x tempo. atempo runs before the pad, so the breathing room
    // between cues stays the same however fast the narration is read.
    expect(normalized.speechDurationSeconds).toBeGreaterThan(1.5);
    expect(normalized.speechDurationSeconds).toBeLessThan(1.8);
    expect(normalized.leadPadSeconds).toBe(NARRATION_EDGE_PAD_SECONDS);
  });

  it("brings a quiet source and a loud one to the same level", async () => {
    const scratchDir = await scratch();
    const [quiet, loud] = await Promise.all([
      toneWithSilence(scratchDir, { gainDb: -26, name: "quiet" }),
      toneWithSilence(scratchDir, { gainDb: -6, name: "loud" }),
    ]);

    const [quietNormalized, loudNormalized] = await Promise.all([
      normalizeCueAudio(processes, { sourcePath: quiet, scratchDir, cueId: "quiet", ratePercent: 0 }),
      normalizeCueAudio(processes, { sourcePath: loud, scratchDir, cueId: "loud", ratePercent: 0 }),
    ]);

    // 20 dB apart going in. A level that still depended on the engine is what made
    // one scene sound like a different speaker from the next.
    const levels = await Promise.all([quietNormalized, loudNormalized].map((cue) => integratedLufs(cue.path)));
    expect(Math.abs(levels[0]! - levels[1]!)).toBeLessThan(1.5);
  });

  it("refuses a source that is not decodable audio", async () => {
    const scratchDir = await scratch();

    await expect(normalizeCueAudio(processes, {
      sourcePath: join(scratchDir, "missing.wav"), scratchDir, cueId: "intro", ratePercent: 0,
    })).rejects.toThrow(/could not be measured for loudness/);
  });

  it("refuses to measure a file that is not there", async () => {
    const scratchDir = await scratch();

    await expect(probeDuration(processes, join(scratchDir, "missing.wav")))
      .rejects.toThrow(/could not be measured/);
  });
});

describe("normalizeCueAudio without a toolchain", () => {
  it("names the missing executable instead of blaming the engine", async () => {
    const scratchDir = await scratch();
    const missing = {
      async run() { throw new Error("spawn ENOENT"); },
    };

    await expect(normalizeCueAudio(missing, {
      sourcePath: join(scratchDir, "any.wav"), scratchDir, cueId: "intro", ratePercent: 0,
    })).rejects.toThrow(/install FFmpeg/);
  });
});
