import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

import { REPOSITORY_ROOT } from "./artifact-layout.mjs";
import {
  FFMPEG_SOURCES,
  X265_CMAKE_ARGS,
  X265_POLICY_SUBSTITUTIONS,
  assertEncoders,
  fetchPinnedSource,
  ffmpegBuildEnvironment,
  ffmpegConfigureArgs,
  ffmpegOutputRoot,
} from "./build-ffmpeg.mjs";

/**
 * The driver `build-ffmpeg.mjs` describes but never had.
 *
 * That module holds the pinned sources and the build rules; until now the steps
 * between them were run by hand, which is why the only FFmpeg the packaging
 * pipeline could reach was the third-party smoke fixture. A release cannot be
 * published from a mirror nobody approved (C-21), and the approved source list
 * is useless if no committed code turns it into binaries.
 *
 * The output of this script is what makes a *release* runtime distinguishable
 * from a *smoke* one: the binaries plus a provenance record naming the exact
 * source archives they were compiled from.
 */
export const RELEASE_MEDIA_PROVENANCE = "release-media-provenance.json";
export const RELEASE_MEDIA_SCHEMA_VERSION = 1;

/**
 * The pinned sources this host actually compiles.
 *
 * Only x86 assemblers reach NASM; on arm64 nothing in the dependency graph
 * calls it. Recording it anyway would put a source in the provenance that never
 * contributed a byte to the binaries the record describes.
 */
/**
 * Where the dependencies are installed, and why it is not under `dist/`.
 *
 * FFmpeg bakes its whole configure line into the binary, so the prefix travels
 * to every machine that runs the artifact — and `verify-artifact` refuses a
 * shipped file carrying the build machine's path, which is how this was found
 * rather than guessed. A fixed location outside the checkout is the same string
 * on every build host and names nobody's home directory.
 */
export function defaultBuildRoot(platform = process.platform) {
  return platform === "win32" ? "C:\\vidcom-release-media" : "/tmp/vidcom-release-media";
}

export function approvedSources(architecture = process.arch) {
  return Object.fromEntries(
    Object.entries(FFMPEG_SOURCES)
      .filter(([name]) => name !== "nasm" || architecture === "x64")
      .map(([name, source]) => [
        name,
        { version: source.version, url: source.url, sha256: source.sha256 },
      ]),
  );
}

function fail(message, details) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  throw new Error(`build-release-media: ${message}${payload}`);
}

async function sha256Of(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function step(name, command, args, options = {}) {
  process.stderr.write(`build-release-media: ${name}\n`);
  const result = spawnSync(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
    ...options,
  });
  if (result.error) fail(`${name} could not start`, { command, cause: result.error.message });
  if (result.status !== 0) fail(`${name} failed`, { exitCode: result.status });
}

function parallelism() {
  return String(Math.max(1, cpus().length - 1));
}

/**
 * Unpacks one pinned archive and returns the single directory it created.
 *
 * Read from the filesystem rather than derived from the archive name: the two
 * agree for five of the six sources and disagree for x264, whose GitLab
 * snapshot is named after the commit. Guessing would work until it silently
 * built nothing.
 */
async function extractSource(name, archive, buildRoot) {
  const target = path.join(buildRoot, "src", name);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  step(`extract ${name}`, "tar", ["-xf", archive, "-C", target]);
  const entries = await readdir(target, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) {
    fail(`${name} did not unpack into one directory`, { found: entries.map((entry) => entry.name) });
  }
  return path.join(target, directories[0].name);
}

/**
 * x265's CMakeLists as current CMake will actually read it.
 *
 * The two substitutions are the ones recorded in `build-ffmpeg.mjs`; applying
 * them here rather than shipping a patch file keeps the change reviewable, and
 * refusing when a marker is missing is what stops a future x265 from being
 * built with an assumption that no longer holds.
 */
async function applyX265Policies(sourceRoot) {
  const cmakeLists = path.join(sourceRoot, "source", "CMakeLists.txt");
  let text = await readFile(cmakeLists, "utf8");
  for (const [from, to] of X265_POLICY_SUBSTITUTIONS) {
    if (!text.includes(from)) fail("x265 no longer contains a policy line this build rewrites", { from });
    text = text.split(from).join(to);
  }
  await writeFile(cmakeLists, text, "utf8");
}

/**
 * Every dynamic dependency the built binary still carries.
 *
 * A static build that quietly linked a package manager's dylib runs on the
 * machine that built it and nowhere else, and that failure only shows up on a
 * user's machine. Asking the linker is the only way to know.
 */
export function dynamicDependencies(binary, platform = process.platform) {
  if (platform === "darwin") {
    const result = spawnSync("otool", ["-L", binary], { encoding: "utf8" });
    if (result.status !== 0) fail("otool would not report the binary's linkage", { binary });
    return result.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" ")[0])
      .filter((entry) => entry.length > 0);
  }
  const result = spawnSync("ldd", [binary], { encoding: "utf8" });
  // A fully static ELF makes `ldd` exit non-zero with "not a dynamic executable",
  // which is the outcome this build wants rather than an error.
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(" ")[0])
    .filter((entry) => entry.length > 0 && entry !== "statically");
}

/**
 * Dependencies a machine that installed nothing is still guaranteed to have.
 *
 * macOS ships its libSystem and frameworks with the OS; a Linux binary linking
 * only the loader and libc is in the same position. Anything else came from the
 * build machine.
 */
export function foreignDependencies(entries, platform = process.platform) {
  const allowed = platform === "darwin"
    ? [/^\/usr\/lib\//u, /^\/System\/Library\/Frameworks\//u]
    : [/^linux-vdso\.so/u, /^\/lib(64)?\/ld-/u, /^lib(c|m|dl|pthread|rt|gcc_s|stdc\+\+)\.so/u];
  return entries.filter((entry) => !allowed.some((pattern) => pattern.test(entry)));
}

function assertStandalone(binary) {
  const foreign = foreignDependencies(dynamicDependencies(binary));
  if (foreign.length > 0) {
    fail("the built binary depends on libraries a clean machine does not have", { binary, foreign });
  }
}

/**
 * Compiles ffmpeg and ffprobe from the approved pinned sources.
 *
 * Each dependency is installed into one private prefix, and FFmpeg is pointed
 * at that prefix alone — `ffmpegBuildEnvironment` is what keeps pkg-config from
 * reaching past it into a package manager's `.pc` files.
 */
export async function buildReleaseMedia(options = {}) {
  const buildRoot = path.resolve(options.buildRoot ?? defaultBuildRoot());
  const outputRoot = path.resolve(options.outputRoot ?? ffmpegOutputRoot());
  const cacheRoot = path.resolve(
    options.cacheRoot
      ?? process.env.VIDCOM_RUNTIME_SOURCE_CACHE
      ?? path.join(REPOSITORY_ROOT, ".vidcom-runtime-source-cache"),
  );
  const prefix = path.join(buildRoot, "prefix");
  const jobs = options.jobs ?? parallelism();
  await mkdir(prefix, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const environment = ffmpegBuildEnvironment(prefix);
  const built = new Set(options.resume === false ? [] : await readdir(path.join(buildRoot, "stamps")).catch(() => []));
  await mkdir(path.join(buildRoot, "stamps"), { recursive: true });

  const archives = {};
  for (const name of Object.keys(approvedSources())) {
    archives[name] = await fetchPinnedSource(name, cacheRoot);
  }

  /** Runs one dependency build unless a previous run already finished it. */
  const stage = async (name, build) => {
    if (built.has(name)) {
      process.stderr.write(`build-release-media: ${name} already built\n`);
      return;
    }
    const sourceRoot = await extractSource(name, archives[name], buildRoot);
    await build(sourceRoot);
    await writeFile(path.join(buildRoot, "stamps", name), "", "utf8");
  };

  if (process.arch === "x64") {
    await stage("nasm", async (source) => {
      step("configure nasm", "./configure", [`--prefix=${prefix}`], { cwd: source, env: environment });
      step("build nasm", "make", ["-j", jobs], { cwd: source, env: environment });
      step("install nasm", "make", ["install"], { cwd: source, env: environment });
    });
  }

  await stage("opus", async (source) => {
    step("configure opus", "./configure", [
      `--prefix=${prefix}`, "--disable-shared", "--enable-static",
      "--disable-doc", "--disable-extra-programs",
    ], { cwd: source, env: environment });
    step("build opus", "make", ["-j", jobs], { cwd: source, env: environment });
    step("install opus", "make", ["install"], { cwd: source, env: environment });
  });

  await stage("x264", async (source) => {
    step("configure x264", "./configure", [
      `--prefix=${prefix}`, "--enable-static", "--enable-pic", "--disable-cli", "--disable-opencl",
    ], { cwd: source, env: { ...environment, PATH: `${path.join(prefix, "bin")}:${environment.PATH}` } });
    step("build x264", "make", ["-j", jobs], { cwd: source, env: environment });
    step("install x264", "make", ["install"], { cwd: source, env: environment });
  });

  await stage("x265", async (source) => {
    await applyX265Policies(source);
    const buildDirectory = path.join(source, "build-static");
    await mkdir(buildDirectory, { recursive: true });
    step("configure x265", "cmake", [
      ...X265_CMAKE_ARGS, `-DCMAKE_INSTALL_PREFIX=${prefix}`, path.join(source, "source"),
    ], { cwd: buildDirectory, env: environment });
    step("build x265", "make", ["-j", jobs], { cwd: buildDirectory, env: environment });
    step("install x265", "make", ["install"], { cwd: buildDirectory, env: environment });
  });

  await stage("libvpx", async (source) => {
    step("configure libvpx", "./configure", [
      `--prefix=${prefix}`, "--enable-static", "--disable-shared", "--enable-pic",
      "--enable-vp9", "--disable-examples", "--disable-tools", "--disable-docs",
      "--disable-unit-tests",
    ], { cwd: source, env: { ...environment, PATH: `${path.join(prefix, "bin")}:${environment.PATH}` } });
    step("build libvpx", "make", ["-j", jobs], { cwd: source, env: environment });
    step("install libvpx", "make", ["install"], { cwd: source, env: environment });
  });

  await stage("ffmpeg", async (source) => {
    step("configure ffmpeg", "./configure", ffmpegConfigureArgs(prefix), {
      cwd: source,
      env: { ...environment, PATH: `${path.join(prefix, "bin")}:${environment.PATH}` },
    });
    step("build ffmpeg", "make", ["-j", jobs], { cwd: source, env: environment });
    step("install ffmpeg", "make", ["install"], { cwd: source, env: environment });
  });

  const suffix = process.platform === "win32" ? ".exe" : "";
  const media = {};
  for (const name of ["ffmpeg", "ffprobe"]) {
    const source = path.join(prefix, "bin", `${name}${suffix}`);
    if (!existsSync(source)) fail("the build did not produce the binary it was asked for", { expected: source });
    const target = path.join(outputRoot, `${name}${suffix}`);
    await rm(target, { force: true });
    await copyFile(source, target);
    await chmod(target, 0o755);
    assertStandalone(target);
    media[name] = { path: target, sha256: await sha256Of(target) };
  }
  assertEncoders(media.ffmpeg.path);

  const provenance = {
    schemaVersion: RELEASE_MEDIA_SCHEMA_VERSION,
    platform: `${process.platform}-${process.arch}`,
    // The claim the packaging step reads back: these bytes were compiled here
    // from the pinned upstream sources, not downloaded from a mirror.
    origin: "source-build",
    sources: approvedSources(),
    ffmpegPath: media.ffmpeg.path,
    ffmpegSha256: media.ffmpeg.sha256,
    ffprobePath: media.ffprobe.path,
    ffprobeSha256: media.ffprobe.sha256,
  };
  const provenancePath = path.join(outputRoot, RELEASE_MEDIA_PROVENANCE);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return { provenancePath, provenance };
}

/**
 * Reads a provenance record back and refuses one that no longer describes disk.
 *
 * Two separate questions, and both have to hold: the record names the approved
 * source pins, and the binaries beside it are still the exact bytes that record
 * measured. A record that only agreed with itself would let any binary be
 * published under a source build's name.
 */
export async function readReleaseMediaProvenance(outputRoot = ffmpegOutputRoot()) {
  const provenancePath = path.join(path.resolve(outputRoot), RELEASE_MEDIA_PROVENANCE);
  let record;
  try {
    record = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch (error) {
    fail("no readable release media provenance", { provenancePath, cause: error.message });
  }
  if (record.schemaVersion !== RELEASE_MEDIA_SCHEMA_VERSION) {
    fail("release media provenance has an unknown schema", { schemaVersion: record.schemaVersion });
  }
  if (record.origin !== "source-build") {
    fail("release media provenance does not describe a source build", { origin: record.origin });
  }
  if (record.platform !== `${process.platform}-${process.arch}`) {
    fail("release media was built for another host", { recorded: record.platform });
  }
  const expected = approvedSources();
  const recorded = record.sources ?? {};
  if (Object.keys(recorded).sort().join(",") !== Object.keys(expected).sort().join(",")) {
    fail("release media provenance does not name the source set this host compiles", {
      recorded: Object.keys(recorded).sort(),
    });
  }
  for (const [name, source] of Object.entries(expected)) {
    if (recorded[name]?.url !== source.url || recorded[name]?.sha256 !== source.sha256) {
      fail("release media was built from a source this build does not approve", { source: name });
    }
  }
  for (const name of ["ffmpeg", "ffprobe"]) {
    const binary = record[`${name}Path`];
    const digest = await sha256Of(binary).catch(() => null);
    if (digest !== record[`${name}Sha256`]) {
      fail("the built binary no longer matches its provenance", {
        binary, expected: record[`${name}Sha256`], actual: digest,
      });
    }
  }
  return record;
}

async function main(argv) {
  const flags = new Map([
    ["--output-root", "outputRoot"],
    ["--build-root", "buildRoot"],
    ["--cache-root", "cacheRoot"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags.get(argv[index]);
    if (!key || argv[index + 1] === undefined) {
      fail("unknown or incomplete argument", { argument: argv[index] });
    }
    options[key] = argv[index + 1];
  }
  const { provenancePath } = await buildReleaseMedia(options);
  process.stderr.write(`build-release-media: ${provenancePath}\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
