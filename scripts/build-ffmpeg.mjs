import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPOSITORY_ROOT } from "./artifact-layout.mjs";

/**
 * The exact sources this build compiles.
 *
 * Pinned by URL and digest together. A version alone names a release that can
 * be re-tagged or re-uploaded; the digest is what makes "the same input"
 * mean the same bytes, which is the only reading that survives a supply-chain
 * question about a binary users run.
 *
 * Every digest here was measured by downloading the source, not copied from a
 * page. FFmpeg's was additionally checked against the value the project
 * publishes, and the x264 snapshot was downloaded twice to confirm the archive
 * is byte-stable rather than regenerated per request.
 *
 * The codec set is not a preference: HyperFrames asks FFmpeg for `libx264`,
 * `libx265`, `libvpx`, `libopus` and the native AAC encoder, and a build
 * missing any one of them fails at render time rather than at build time.
 */
export const FFMPEG_SOURCES = Object.freeze({
  nasm: {
    version: "2.16.03",
    url: "https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/nasm-2.16.03.tar.gz",
    sha256: "sha256:5bc940dd8a4245686976a8f7e96ba9340a0915f2d5b88356874890e207bdb581",
  },
  opus: {
    version: "1.5.2",
    url: "https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz",
    sha256: "sha256:65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1",
  },
  x264: {
    // A commit, not a branch. x264 publishes no release tarballs, and `stable`
    // is a moving target — pinning the branch would mean a different compiler
    // output every time somebody rebuilds the same "version".
    version: "stable-b35605ac",
    url: "https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz",
    sha256: "sha256:cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9",
  },
  x265: {
    version: "3.6",
    url: "https://bitbucket.org/multicoreware/x265_git/downloads/x265_3.6.tar.gz",
    sha256: "sha256:663531f341c5389f460d730e62e10a4fcca3428ca2ca109693867bc5fe2e2807",
  },
  libvpx: {
    version: "1.14.1",
    url: "https://github.com/webmproject/libvpx/archive/refs/tags/v1.14.1.tar.gz",
    sha256: "sha256:901747254d80a7937c933d03bd7c5d41e8e6c883e0665fadcb172542167c7977",
  },
  ffmpeg: {
    version: "7.1.1",
    url: "https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz",
    sha256: "sha256:733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1",
  },
});

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`build-ffmpeg: ${message}${payload}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

export function ffmpegBuildRoot() {
  return path.join(REPOSITORY_ROOT, "dist", "ffmpeg-build");
}

export function ffmpegOutputRoot() {
  return path.join(REPOSITORY_ROOT, "dist", "ffmpeg");
}

async function sha256Of(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Downloads one source archive and refuses anything that is not the pinned bytes.
 *
 * Checked after the download rather than trusted from the URL: a mirror, a
 * re-tagged release and a compromised host all serve a 200 for the same
 * address, and the digest is the only part of the pin they cannot satisfy.
 */
export async function fetchPinnedSource(name, cacheRoot, source = FFMPEG_SOURCES[name]) {
  if (!source) fail(`no pinned source named ${name}`);
  await mkdir(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, path.basename(new URL(source.url).pathname));
  if (existsSync(target)) {
    const cached = await sha256Of(target);
    if (cached === source.sha256) return target;
    await rm(target, { force: true });
  }

  const response = await fetch(source.url);
  if (!response.ok) fail(`could not download ${name}`, { status: response.status, url: source.url });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(target, Buffer.from(await response.arrayBuffer()));

  const digest = await sha256Of(target);
  if (digest !== source.sha256) {
    await rm(target, { force: true });
    fail(`${name} does not match its pinned digest`, { expected: source.sha256, actual: digest });
  }
  return target;
}

export function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
    ...options,
  });
  if (result.error) fail(`${name} could not start`, { command, cause: result.error.message });
  if (result.status !== 0) fail(`${name} failed`, { exitCode: result.status });
}

/**
 * The configure flags that make the output shippable.
 *
 * Static and standalone, because the artifact carries this binary to machines
 * that have none of these libraries. `--disable-debug` keeps the build root out
 * of the shipped bytes, which the artifact verifier refuses on sight.
 */
export function ffmpegBuildEnvironment(prefix, base = process.env) {
  return {
    ...base,
    // `PKG_CONFIG_LIBDIR`, not just `PKG_CONFIG_PATH`. pkg-config keeps its own
    // default search list, and a package manager's `.pc` files sit on it — which
    // is exactly how a "static" build ends up linking a system dylib and only
    // fails on a machine that never had the package manager. Measured here: the
    // first build linked Homebrew's libx265 despite every static flag.
    PKG_CONFIG_LIBDIR: path.join(prefix, "lib", "pkgconfig"),
    PKG_CONFIG_PATH: path.join(prefix, "lib", "pkgconfig"),
  };
}

export function ffmpegConfigureArgs(prefix) {
  return [
    `--prefix=${prefix}`,
    `--extra-cflags=-I${prefix}/include`,
    `--extra-ldflags=-L${prefix}/lib`,
    "--pkg-config-flags=--static",
    "--enable-gpl",
    "--enable-version3",
    "--enable-static",
    "--disable-shared",
    "--enable-libx264",
    "--enable-libx265",
    "--enable-libvpx",
    "--enable-libopus",
    "--disable-debug",
    "--disable-doc",
    "--disable-ffplay",
    "--disable-autodetect",
  ];
}

/**
 * x265 needs telling that an old policy version is acceptable.
 *
 * Its CMake files declare a minimum below what current CMake will accept
 * without complaint, so a plain configure stops with "Configuring incomplete".
 * Named here rather than discovered again: the first build swallowed that
 * failure, FFmpeg then found the system libx265 through pkg-config's default
 * search path, and the result linked a dylib no user machine has.
 */
export const X265_CMAKE_ARGS = Object.freeze([
  "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
  "-DENABLE_SHARED=OFF",
  "-DENABLE_CLI=OFF",
  "-DCMAKE_BUILD_TYPE=Release",
]);

export const REQUIRED_ENCODERS = Object.freeze(["libx264", "libx265", "libvpx-vp9", "libopus", "aac"]);

/**
 * Confirms the binary can actually do the work the render pipeline asks for.
 *
 * A build that configured without a codec still produces a working `ffmpeg`;
 * it just fails at the first render. Asking the binary for its encoder list is
 * how that turns into a build failure instead.
 */
export function assertEncoders(ffmpegPath, encoders = REQUIRED_ENCODERS) {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (result.status !== 0) fail("the built ffmpeg would not list its encoders", { ffmpegPath });
  const missing = encoders.filter((encoder) => !new RegExp(`\\b${encoder}\\b`, "u").test(result.stdout));
  if (missing.length > 0) fail("the built ffmpeg is missing required encoders", { missing });
  return encoders;
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  process.stderr.write(
    "build-ffmpeg: this module holds the pinned sources and the build rules;"
    + " the per-platform driver runs them.\n",
  );
}
