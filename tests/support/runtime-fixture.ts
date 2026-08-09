import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  RUNTIME_PLATFORM_TAGS,
  type EmbeddedArchive,
  type EmbeddedRuntimeManifest,
  type RuntimeAssetSource,
  type RuntimePlatformTag,
} from "@vidcom/adapter";
import { MOTION_LIBRARIES, type ContentHash } from "@vidcom/contracts";

export const HOST_TAG = `${process.platform}-${process.arch}` as RuntimePlatformTag;
export const HOST_SUPPORTED = RUNTIME_PLATFORM_TAGS.includes(HOST_TAG);

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "character-device";

export interface TarEntry {
  path: string;
  type?: TarEntryType;
  mode?: number;
  content?: Buffer;
  linkname?: string;
}

const TYPE_FLAGS: Readonly<Record<TarEntryType, string>> = {
  file: "0",
  hardlink: "1",
  symlink: "2",
  "character-device": "3",
  directory: "5",
};

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/**
 * Minimal ustar writer. `tar` resolves only from `packages/adapter`, so archive
 * fixtures are built here instead of importing the extractor's dependency into
 * the repository-root test graph.
 */
function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  const type = entry.type ?? "file";
  block.write(entry.path, 0, 100, "utf8");
  block.write(octal(entry.mode ?? 0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(TYPE_FLAGS[type], 156, 1, "ascii");
  if (entry.linkname) block.write(entry.linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** Builds a gzipped tar from raw entries; the caller owns manifest agreement. */
export function tarball(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.type === "file" || entry.type === undefined
      ? entry.content ?? Buffer.alloc(0)
      : Buffer.alloc(0);
    blocks.push(header(entry, body.byteLength), body);
    const padding = (512 - (body.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function digest(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

export interface FixtureFile {
  path: string;
  content: Buffer;
  mode?: number;
}

export interface ProductFixtureEntries {
  node: readonly FixtureFile[];
  hyperframes: readonly FixtureFile[];
  native: readonly FixtureFile[];
}

/** Complete host product contract used by real-archive integration fixtures. */
export function productRuntimeFixtureEntries(
  migrations: readonly FixtureFile[] = [],
  platformTag: RuntimePlatformTag = HOST_TAG,
): ProductFixtureEntries {
  const windows = platformTag === "win32-x64";
  const suffix = windows ? ".exe" : "";
  const commonNativePackageNames = [
    "sharp",
    "@img/colour",
    "detect-libc",
    "semver",
    "esbuild",
    "onnxruntime-node",
    "onnxruntime-common",
  ];
  const platformPackageNames = platformTag === "darwin-arm64"
    ? ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64", "@esbuild/darwin-arm64"]
    : platformTag === "linux-x64"
      ? ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@esbuild/linux-x64"]
      : ["@img/sharp-win32-x64", "@esbuild/win32-x64"];
  const onnxPlatform = windows ? "win32" : platformTag.split("-", 1)[0]!;
  const onnxArchitecture = platformTag.endsWith("-arm64") ? "arm64" : "x64";
  const onnxRoot = `node_modules/onnxruntime-node/bin/napi-v3/${onnxPlatform}/${onnxArchitecture}`;
  const platformEsbuild = windows
    ? "node_modules/@esbuild/win32-x64/esbuild.exe"
    : `node_modules/@esbuild/${platformTag}/bin/esbuild`;
  const native: FixtureFile[] = [
    ...[...commonNativePackageNames, ...platformPackageNames].map((name) => ({
      path: `node_modules/${name}/package.json`,
      content: Buffer.from(`{"name":${JSON.stringify(name)}}\n`, "utf8"),
    })),
    {
      path: "node_modules/onnxruntime-node/dist/index.js",
      content: Buffer.from("module.exports = {};\n", "utf8"),
    },
    { path: `${onnxRoot}/onnxruntime_binding.node`, content: Buffer.from("binding\n", "utf8") },
    {
      path: windows
        ? `${onnxRoot}/onnxruntime.dll`
        : platformTag === "darwin-arm64"
          ? `${onnxRoot}/libonnxruntime.1.0.0.dylib`
          : `${onnxRoot}/libonnxruntime.so.1`,
      content: Buffer.from("runtime\n", "utf8"),
    },
    { path: platformEsbuild, content: Buffer.from("esbuild\n", "utf8"), mode: 0o755 },
    {
      path: `node_modules/@img/sharp-${platformTag}/lib/sharp-${platformTag}.node`,
      content: Buffer.from("sharp\n", "utf8"),
    },
    ...windows ? [] : [{
      path: `node_modules/@img/sharp-libvips-${platformTag}/lib/libvips-cpp.${
        platformTag === "darwin-arm64" ? "1.dylib" : "so.1"
      }`,
      content: Buffer.from("libvips\n", "utf8"),
    }],
  ];
  return {
    node: [
      { path: `bin/ffmpeg${suffix}`, content: Buffer.from("ffmpeg\n"), mode: windows ? 0o666 : 0o755 },
      { path: `bin/ffprobe${suffix}`, content: Buffer.from("ffprobe\n"), mode: windows ? 0o666 : 0o755 },
      { path: `bin/esbuild${suffix}`, content: Buffer.from("esbuild\n"), mode: windows ? 0o666 : 0o755 },
      {
        path: windows ? "python/python.exe" : "python/bin/python3",
        content: Buffer.from("python\n"),
        mode: windows ? 0o666 : 0o755,
      },
      { path: "vieneu/worker.py", content: Buffer.from("# worker\n") },
      ...migrations,
    ],
    hyperframes: [
      { path: "bin/hyperframes.mjs", content: Buffer.from("export {};\n", "utf8") },
      { path: "package.json", content: Buffer.from('{"name":"hyperframes","version":"0.7.86"}\n', "utf8") },
      { path: "bin/hyperframe.manifest.json", content: Buffer.from("{}\n", "utf8") },
      { path: "bin/hyperframe.runtime.iife.js", content: Buffer.from("void 0;\n", "utf8") },
      ...MOTION_LIBRARIES.flatMap((library) => [{
        path: `motion-libraries/${library.packageName}/package.json`,
        content: Buffer.from(
          `{"name":${JSON.stringify(library.packageName)},"version":${JSON.stringify(library.version)}}\n`,
          "utf8",
        ),
      }, ...library.files.map(({ packagePath }) => ({
        path: `motion-libraries/${library.packageName}/${packagePath}`,
        content: Buffer.from(`${library.packageName}:${packagePath}\n`, "utf8"),
      }))]),
    ],
    native,
  };
}

/** Builds one archive plus the manifest projection that exactly describes it. */
export function archiveFor(
  key: string,
  files: readonly FixtureFile[],
  platform: RuntimePlatformTag = HOST_TAG,
  target = key,
): { bytes: Buffer; archive: EmbeddedArchive } {
  const bytes = tarball(files.map((file) => ({
    path: file.path,
    type: "file" as const,
    mode: file.mode ?? 0o644,
    content: file.content,
  })));
  return {
    bytes,
    archive: {
      key,
      platform,
      sha256: digest(bytes),
      bytes: bytes.byteLength,
      target,
      entries: files.map((file) => ({
        path: file.path,
        sha256: digest(file.content),
        mode: file.mode ?? 0o644,
      })),
    },
  };
}

/** Oversized on demand: B.5 needs a projection larger than the 1 MiB state bound. */
export function pythonPackages(
  count = 1,
  tag: RuntimePlatformTag = HOST_TAG,
): Readonly<Record<RuntimePlatformTag, readonly string[]>> {
  const bulk = Array.from(
    { length: count },
    (_unused, index) => `pkg-${String(index).padStart(6, "0")}==1.0.0`,
  );
  const packages = {} as Record<RuntimePlatformTag, readonly string[]>;
  for (const platform of RUNTIME_PLATFORM_TAGS) {
    packages[platform] = platform === tag ? bulk : ["certifi==2024.2.2"];
  }
  return Object.freeze(packages);
}

export function runtimeManifest(
  artifactVersion: string,
  archives: readonly EmbeddedArchive[],
  packageCount = 1,
): EmbeddedRuntimeManifest {
  return {
    schemaVersion: 1,
    artifactVersion,
    versions: {
      node: "24.9.0",
      hyperframes: "0.7.86",
      esbuild: "0.25.12",
      ffmpeg: "7.1",
      cpython: "3.12.13+20260805",
      vieneu: "3.2.4",
      motion: {
        animejs: "4.5.0",
        gsap: "3.15.0",
        "lottie-web": "5.13.0",
        motion: "12.43.0",
        three: "0.185.1",
      },
    },
    pythonPackages: pythonPackages(packageCount),
    archives,
  };
}

export function assetSource(
  manifest: EmbeddedRuntimeManifest,
  archives: Readonly<Record<string, Buffer>>,
): RuntimeAssetSource {
  return {
    readManifest: () => manifest,
    readArchive: (key) => {
      const bytes = archives[key];
      if (!bytes) throw new Error(`fixture archive ${key} is absent`);
      return Uint8Array.from(bytes);
    },
  };
}
