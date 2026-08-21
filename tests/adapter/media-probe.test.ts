import { access, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeAssetProbe } from "@vidcom/adapter";
import type { ProjectId, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, ProcessPort, ProcessRunInput, ProjectRef } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-media-probe-")));
  roots.push(root);
  await mkdir(path.join(root, "assets"));
  const ref: ProjectRef = {
    id: "project_media_probe" as ProjectId,
    slug: "media-probe",
    root: root as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  return { root, ref };
}

async function systemFont(): Promise<string | null> {
  for (const candidate of [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Verdana.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the deterministic cross-platform fixture allowlist.
    }
  }
  return null;
}

describe("NodeAssetProbe", () => {
  it("runs the injected absolute ffprobe command and parses media metadata", async () => {
    const value = await fixture();
    const target = path.join(value.root, "assets", "clip.mp4");
    await writeFile(target, new Uint8Array(321));
    const calls: ProcessRunInput[] = [];
    const processes: ProcessPort = {
      async run(input) {
        calls.push(input);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: "4.25", size: "321" },
            streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, duration: "4.2" }],
          }),
          stderr: "",
          timedOut: false,
        };
      },
    };
    const ffprobePath = path.resolve("/verified/runtime/bin/ffprobe") as AbsolutePath;
    const probe = new NodeAssetProbe(processes, ffprobePath);

    await expect(probe.probeMedia(value.ref, "assets/clip.mp4" as RelPath)).resolves.toEqual({
      ok: true,
      value: {
        status: "ok",
        kind: "media",
        byteSize: 321,
        durationSeconds: 4.25,
        width: 1920,
        height: 1080,
        codec: "h264",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: [
        ffprobePath,
        "-v", "error",
        "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,duration",
        "-of", "json",
        target,
      ],
      timeoutMs: 10_000,
      captureMaxBytes: 256 * 1024,
    });
  });

  it("returns explicit unknown metadata when ffprobe cannot inspect the committed file", async () => {
    const value = await fixture();
    await writeFile(path.join(value.root, "assets", "clip.mov"), new Uint8Array(17));
    const probe = new NodeAssetProbe({
      async run() { return { exitCode: 1, stdout: "", stderr: "codec unsupported", timedOut: false }; },
    }, path.resolve("/verified/ffprobe") as AbsolutePath);

    await expect(probe.probeMedia(value.ref, "assets/clip.mov" as RelPath)).resolves.toEqual({
      ok: true,
      value: { status: "unknown", byteSize: 17, reason: "ffprobe could not read asset metadata" },
    });
  });

  it("rejects a project-local symlink before media or font inspection", async () => {
    const value = await fixture();
    await writeFile(path.join(value.root, "assets", "real.mp4"), new Uint8Array(17));
    await symlink("real.mp4", path.join(value.root, "assets", "linked.mp4"));
    const calls: ProcessRunInput[] = [];
    const probe = new NodeAssetProbe({
      async run(input) {
        calls.push(input);
        return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
      },
    }, path.resolve("/verified/ffprobe") as AbsolutePath);

    await expect(probe.probeMedia(value.ref, "assets/linked.mp4" as RelPath)).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(calls).toHaveLength(0);
  });

  it("reads family and style from a real project-local font", async (context) => {
    const font = await systemFont();
    if (!font) return context.skip("no known system font is installed");
    const value = await fixture();
    const target = path.join(value.root, "assets", "verified.ttf");
    await copyFile(font, target);
    const probe = new NodeAssetProbe({
      async run() { throw new Error("font probing must not spawn ffprobe"); },
    }, path.resolve("/verified/ffprobe") as AbsolutePath);

    const result = await probe.probeFont(value.ref, "assets/verified.ttf" as RelPath);
    expect(result).toMatchObject({ ok: true, value: {
      status: "ok",
      kind: "font",
      byteSize: expect.any(Number),
      family: expect.any(String),
      style: expect.any(String),
    } });
    if (result.ok && result.value.status === "ok") {
      expect(result.value.byteSize).toBeGreaterThan(0);
      expect(result.value.family.length).toBeGreaterThan(0);
      expect(result.value.style.length).toBeGreaterThan(0);
    }
  });
});
