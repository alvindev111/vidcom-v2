import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  RUNTIME_PLATFORM_TAGS,
  type EmbeddedArchive,
  type EmbeddedRuntimeManifest,
  type RuntimeAssetSource,
  type RuntimePlatformTag,
} from "@vidcom/adapter";
import type { ContentHash } from "@vidcom/contracts";

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

/** Builds one archive plus the manifest projection that exactly describes it. */
export function archiveFor(
  key: string,
  files: readonly FixtureFile[],
  platform: RuntimePlatformTag = HOST_TAG,
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
      target: "runtime",
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
      hyperframes: "1.0.0",
      esbuild: "0.25.0",
      ffmpeg: "7.1",
      cpython: "3.12.7",
      vieneu: "1.0.0",
      motion: {
        animejs: "3.2.2",
        gsap: "3.12.5",
        "lottie-web": "5.12.2",
        motion: "11.0.0",
        three: "0.164.0",
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
