import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeProcessRunner, normalizeCueAudio, probeDuration } from "@vidcom/adapter";

const processes = new NodeProcessRunner();
const directories: string[] = [];

async function scratch(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "vidcom-ffmpeg-"));
  directories.push(created);
  return created;
}

/** Two seconds of tone padded with silence, so the trim has something to remove. */
async function toneWithSilence(scratchDir: string): Promise<string> {
  const path = join(scratchDir, "source.wav");
  const result = await processes.run({
    command: [
      "ffmpeg", "-y", "-v", "error",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.5",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.5",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map", "[out]", "-ar", "48000", "-ac", "2", path,
    ],
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return path;
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

  it("trims the padding so the reported duration is the speech, not the file", async () => {
    const scratchDir = await scratch();
    const sourcePath = await toneWithSilence(scratchDir);

    const normalized = await normalizeCueAudio(processes, {
      sourcePath, scratchDir, cueId: "intro", ratePercent: 0,
    });

    // Source is 3s: 0.5s silence, 2s tone, 0.5s silence.
    expect(normalized.durationSeconds).toBeGreaterThan(1.8);
    expect(normalized.durationSeconds).toBeLessThan(2.2);
  });

  it("speeds the audio up by the requested rate", async () => {
    const scratchDir = await scratch();
    const sourcePath = await toneWithSilence(scratchDir);

    const normalized = await normalizeCueAudio(processes, {
      sourcePath, scratchDir, cueId: "fast", ratePercent: 20,
    });

    // 2s of tone at 1.2x tempo.
    expect(normalized.durationSeconds).toBeGreaterThan(1.5);
    expect(normalized.durationSeconds).toBeLessThan(1.8);
  });

  it("refuses a source that is not decodable audio", async () => {
    const scratchDir = await scratch();

    await expect(normalizeCueAudio(processes, {
      sourcePath: join(scratchDir, "missing.wav"), scratchDir, cueId: "intro", ratePercent: 0,
    })).rejects.toThrow(/could not be converted/);
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
