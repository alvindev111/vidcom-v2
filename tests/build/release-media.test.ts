import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REPOSITORY_ROOT } from "../../scripts/artifact-layout.mjs";
import { FFMPEG_SOURCES } from "../../scripts/build-ffmpeg.mjs";
import {
  RELEASE_MEDIA_PROVENANCE,
  approvedSources,
  defaultBuildRoot,
  foreignDependencies,
  readReleaseMediaProvenance,
} from "../../scripts/build-release-media.mjs";
import { preparePackagedRuntime } from "../../scripts/prepare-packaged-runtime.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digestOf(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * A release media directory made of files, not of a two-hour compile.
 *
 * What `readReleaseMediaProvenance` is responsible for is deciding whether a
 * record still describes the bytes beside it and names the approved sources —
 * neither question needs the bytes to be a real encoder.
 */
async function releaseMediaRoot(
  overrides: Record<string, unknown> = {},
  bodies: { ffmpeg: string; ffprobe: string } = { ffmpeg: "ffmpeg-bytes", ffprobe: "ffprobe-bytes" },
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-release-media-"));
  roots.push(root);
  const ffmpegPath = path.join(root, "ffmpeg");
  const ffprobePath = path.join(root, "ffprobe");
  await writeFile(ffmpegPath, bodies.ffmpeg, "utf8");
  await writeFile(ffprobePath, bodies.ffprobe, "utf8");
  const record = {
    schemaVersion: 1,
    platform: `${process.platform}-${process.arch}`,
    origin: "source-build",
    sources: approvedSources(),
    ffmpegPath,
    ffmpegSha256: digestOf(bodies.ffmpeg),
    ffprobePath,
    ffprobeSha256: digestOf(bodies.ffprobe),
    ...overrides,
  };
  await writeFile(
    path.join(root, RELEASE_MEDIA_PROVENANCE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return root;
}

describe("release media provenance", () => {
  it("accepts a record that names the approved sources and still matches the binaries", async () => {
    const record = await readReleaseMediaProvenance(await releaseMediaRoot());
    expect(record.origin).toBe("source-build");
    expect(record.sources.ffmpeg.url).toBe(FFMPEG_SOURCES.ffmpeg.url);
  });

  it("refuses a record whose binaries were replaced after it was written", async () => {
    // The record is written for one set of bytes and the file on disk is
    // another: a check that only read the record would agree with itself and
    // let any binary be published under a source build's name.
    const root = await releaseMediaRoot({ ffmpegSha256: digestOf("some-other-ffmpeg") });
    await expect(readReleaseMediaProvenance(root)).rejects.toThrow(/no longer matches its provenance/u);
  });

  it("refuses a source pin this build does not approve", async () => {
    const sources = {
      ...approvedSources(),
      ffmpeg: {
        version: FFMPEG_SOURCES.ffmpeg.version,
        url: "https://mirror.example.invalid/ffmpeg-7.1.1.tar.xz",
        sha256: FFMPEG_SOURCES.ffmpeg.sha256,
      },
    };
    await expect(readReleaseMediaProvenance(await releaseMediaRoot({ sources })))
      .rejects.toThrow(/does not approve/u);
  });

  it("refuses a record that drops one of the sources this host compiles", async () => {
    // A missing entry is not a smaller claim, it is an unmade one: the check
    // below only compares what is present, so an absent source would pass every
    // comparison it never took part in.
    const sources = approvedSources();
    delete sources.opus;
    await expect(readReleaseMediaProvenance(await releaseMediaRoot({ sources })))
      .rejects.toThrow(/does not name the source set/u);
  });

  it("refuses a downloaded fixture relabelled as a source build", async () => {
    await expect(readReleaseMediaProvenance(await releaseMediaRoot({ origin: "download" })))
      .rejects.toThrow(/does not describe a source build/u);
  });

  it("refuses a record built for another host", async () => {
    await expect(readReleaseMediaProvenance(await releaseMediaRoot({ platform: "solaris-sparc" })))
      .rejects.toThrow(/built for another host/u);
  });

  it("refuses an unknown schema instead of reading the fields it recognises", async () => {
    await expect(readReleaseMediaProvenance(await releaseMediaRoot({ schemaVersion: 2 })))
      .rejects.toThrow(/unknown schema/u);
  });

  it("installs outside the checkout, because the prefix ships inside the binary", () => {
    // FFmpeg bakes its configure line into the executable, so a prefix under
    // the checkout would put the build machine's path in every artifact — which
    // is exactly what `verify-artifact` refuses.
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(defaultBuildRoot(platform).startsWith(REPOSITORY_ROOT)).toBe(false);
    }
    expect(defaultBuildRoot("darwin")).not.toContain("Users");
  });

  it("reports every dynamic dependency a clean machine would not already have", () => {
    const darwin = foreignDependencies([
      "/usr/lib/libSystem.B.dylib",
      "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
      "/opt/homebrew/opt/x265/lib/libx265.209.dylib",
    ], "darwin");
    expect(darwin).toEqual(["/opt/homebrew/opt/x265/lib/libx265.209.dylib"]);
    expect(foreignDependencies(["linux-vdso.so.1", "libc.so.6", "/usr/lib/x86_64-linux-gnu/libx264.so.164"], "linux"))
      .toEqual(["/usr/lib/x86_64-linux-gnu/libx264.so.164"]);
  });
});

describe("packaged runtime media supply chain", () => {
  it("still refuses the smoke fixture without its opt-in", async () => {
    await expect(preparePackagedRuntime({ platform: "darwin-arm64" }))
      .rejects.toThrow(/not an approved release supply chain/u);
  });

  it("does not let the release path skip the gate when it has no source build to show", async () => {
    // Asking for release media is not itself permission: with no provenance to
    // read, this must fail on the missing proof rather than fall through to the
    // fixture the opt-in exists to keep out of a release.
    const empty = await mkdtemp(path.join(tmpdir(), "vidcom-release-media-empty-"));
    roots.push(empty);
    await expect(preparePackagedRuntime({ releaseMedia: true, releaseMediaRoot: empty }))
      .rejects.toThrow(/no readable release media provenance/u);
  });
});
