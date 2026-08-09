import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FFMPEG_VERSION_PATTERN,
  FFPROBE_VERSION_PATTERN,
  buildRuntimeInputs,
  writeRuntimeInputs,
} from "../../scripts/build-runtime-inputs.mjs";
import { hostPlatformTag, parseRuntimeInputsValue } from "../../scripts/stage-artifact-runtime.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A frozen runtime made of scripts that answer like the real binaries.
 *
 * Real FFmpeg and a real CPython are hundreds of megabytes and not present on
 * a test machine. What this file is responsible for is measuring whatever it
 * is pointed at, so shell scripts that report a version and hold bytes exercise
 * exactly that.
 */
async function frozenRuntime(): Promise<{
  pythonRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  pythonPackagesPath: string;
  output: string;
}> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-inputs-")));
  roots.push(root);
  const pythonRoot = path.join(root, "python");
  await mkdir(path.join(pythonRoot, "bin"), { recursive: true });

  const pythonPath = path.join(pythonRoot, "bin", "python3.12");
  await writeFile(pythonPath, "#!/bin/sh\necho 3.12.13\n", { encoding: "utf8", mode: 0o755 });
  await writeFile(path.join(pythonRoot, "lib.txt"), "frozen", "utf8");

  // Ordinary files, not scripts. What matters here is that their bytes get
  // hashed; asking them for a version goes through the injected seam, because a
  // shell script is not an executable on Windows and a test that only runs on
  // two of the three platforms is not a test of the build.
  const media = async (name: string) => {
    const file = path.join(root, name);
    await writeFile(file, `${name} bytes`, "utf8");
    return file;
  };

  const packages = path.join(root, "package-set.txt");
  await writeFile(packages, "vieneu==3.2.4\n", "utf8");

  return {
    pythonRoot,
    pythonPath,
    ffmpegPath: await media("ffmpeg"),
    ffprobePath: await media("ffprobe"),
    pythonPackagesPath: packages,
    output: path.join(root, "darwin-arm64.json"),
  };
}

const HOST_TAG: string = hostPlatformTag();
// Something this machine is definitely not, so the cross-build refusal is a
// real mismatch on every runner rather than only on the one it was written on.
const FOREIGN_TAG = HOST_TAG === "linux-x64" ? "darwin-arm64" : "linux-x64";

function options(frozen: Awaited<ReturnType<typeof frozenRuntime>>) {
  return {
    ...frozen,
    platform: HOST_TAG,
    artifactVersion: "2026.08.09",
    cpythonVersion: "3.12.13+20260805",
    readVersion: () => "7.1.1",
    vieneuRoot: path.resolve("packages/adapter/sidecars/vieneu"),
  };
}

describe("runtime inputs", () => {
  it("measures every digest from the bytes on disk", async () => {
    // The file exists to be re-checked by staging. A value copied from a
    // release page rather than measured would make that check agree with
    // itself and prove nothing.
    const frozen = await frozenRuntime();
    const inputs = await buildRuntimeInputs(options(frozen));
    const expected = createHash("sha256")
      .update(await readFile(frozen.ffmpegPath))
      .digest("hex");
    expect(inputs.ffmpegSha256).toBe(`sha256:${expected}`);
    expect(inputs.pythonTreeSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("takes the version from the binary, not from the caller", async () => {
    // A version supplied by hand describes the download page; the binary's own
    // answer describes the bytes that actually ended up here.
    const frozen = await frozenRuntime();
    const inputs = await buildRuntimeInputs(options(frozen));
    expect(inputs.ffmpegVersion).toBe("7.1.1");
    expect(inputs.ffprobeVersion).toBe("7.1.1");
  });

  it("reads the version out of the real ffmpeg banner shape", () => {
    expect(FFMPEG_VERSION_PATTERN.exec("ffmpeg version 8.0.1 Copyright (c)")?.[1]).toBe("8.0.1");
    expect(FFPROBE_VERSION_PATTERN.exec("ffprobe version n7.1.1-static")?.[1]).toBe("n7.1.1-static");
  });

  it("produces a file staging accepts without a second parser", async () => {
    // Validated by the very function staging uses, so a shape this generator
    // gets wrong fails here rather than three build steps later.
    const frozen = await frozenRuntime();
    const { target } = await writeRuntimeInputs(options(frozen));
    const written = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    expect(() => parseRuntimeInputsValue(written, HOST_TAG)).not.toThrow();
  });

  it("refuses to describe a runtime for another platform", async () => {
    const frozen = await frozenRuntime();
    await expect(buildRuntimeInputs({ ...options(frozen), platform: FOREIGN_TAG }))
      .rejects.toThrow(/do not match the build host|must be/u);
  });

  it("says so when a binary will not report itself", async () => {
    // The real reader spawns the binary; a file that is not one fails there,
    // which is the message a build needs rather than a digest of nothing.
    const frozen = await frozenRuntime();
    await expect(buildRuntimeInputs({
      ...options(frozen),
      readVersion: undefined,
      ffmpegPath: path.join(frozen.pythonRoot, "lib.txt"),
    })).rejects.toThrow(/would not report its version|could not read a version/u);
  });
});
