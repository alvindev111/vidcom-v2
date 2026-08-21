import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import * as fontkit from "fontkit";

import { ErrorCode, type DomainError, type RelPath } from "@vidcom/contracts";
import {
  err,
  ok,
  ASSET_POLICIES,
  type AbsolutePath,
  type FontAssetMetadata,
  type MediaAssetMetadata,
  type MediaProbePort,
  type ProcessPort,
  type ProjectRef,
  type Result,
  type UnknownAssetMetadata,
} from "@vidcom/core";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CAPTURE_BYTES = 256 * 1024;

interface FfprobeJson {
  format?: { duration?: unknown; size?: unknown };
  streams?: Array<{
    codec_type?: unknown;
    codec_name?: unknown;
    width?: unknown;
    height?: unknown;
    duration?: unknown;
  }>;
}

async function containedRegularFile(
  ref: ProjectRef,
  relativePath: RelPath,
): Promise<{ filename: AbsolutePath; byteSize: number } | null> {
  const candidate = path.resolve(ref.root, relativePath);
  const lexical = path.relative(ref.root, candidate);
  if (!lexical || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) return null;
  try {
    const link = await lstat(candidate);
    if (!link.isFile() || link.isSymbolicLink()) return null;
    const [root, target] = await Promise.all([realpath(ref.root), realpath(candidate)]);
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const metadata = await stat(target);
    return metadata.isFile() ? { filename: target as AbsolutePath, byteSize: metadata.size } : null;
  } catch {
    return null;
  }
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function unknown(byteSize: number | null, reason: string): Result<UnknownAssetMetadata, DomainError> {
  return ok({ status: "unknown", byteSize, reason });
}

function fonts(resource: fontkit.Font | fontkit.FontCollection): fontkit.Font[] {
  return "fonts" in resource ? resource.fonts : [resource];
}

/** Project-local ffprobe/fontkit adapter; executable selection is injected by composition root. */
export class NodeAssetProbe implements MediaProbePort {
  constructor(
    readonly processes: ProcessPort,
    readonly ffprobePath: AbsolutePath,
  ) {}

  async probeMedia(
    ref: ProjectRef,
    assetPath: RelPath,
  ): Promise<Result<MediaAssetMetadata | UnknownAssetMetadata, DomainError>> {
    const file = await containedRegularFile(ref, assetPath);
    if (!file) return err({ code: ErrorCode.NotFound, message: "asset file was not found" });
    let output;
    try {
      output = await this.processes.run({
        command: [
          this.ffprobePath,
          "-v", "error",
          "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,duration",
          "-of", "json",
          file.filename,
        ],
        timeoutMs: PROBE_TIMEOUT_MS,
        captureMaxBytes: PROBE_CAPTURE_BYTES,
      });
    } catch {
      return unknown(file.byteSize, "ffprobe is unavailable");
    }
    if (output.exitCode !== 0 || output.timedOut) {
      return unknown(file.byteSize, "ffprobe could not read asset metadata");
    }
    let parsed: FfprobeJson;
    try { parsed = JSON.parse(output.stdout) as FfprobeJson; }
    catch { return unknown(file.byteSize, "ffprobe returned invalid metadata"); }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const stream = streams.find((item) => item.codec_type === "video")
      ?? streams.find((item) => item.codec_type === "audio")
      ?? streams[0];
    const durationSeconds = finite(parsed.format?.duration) ?? finite(stream?.duration);
    const codec = typeof stream?.codec_name === "string" && stream.codec_name.length > 0
      ? stream.codec_name
      : null;
    return ok({
      status: "ok",
      kind: "media",
      byteSize: file.byteSize,
      durationSeconds,
      width: positiveInteger(stream?.width),
      height: positiveInteger(stream?.height),
      codec,
    });
  }

  async probeFont(
    ref: ProjectRef,
    assetPath: RelPath,
  ): Promise<Result<FontAssetMetadata | UnknownAssetMetadata, DomainError>> {
    const file = await containedRegularFile(ref, assetPath);
    if (!file) return err({ code: ErrorCode.NotFound, message: "font file was not found" });
    if (file.byteSize > ASSET_POLICIES.font.maxBytes) {
      return unknown(file.byteSize, "font exceeds the supported metadata limit");
    }
    try {
      const resource = fontkit.create(Buffer.from(await readFile(file.filename)));
      const font = fonts(resource)[0];
      if (!font?.familyName || !font.subfamilyName) {
        return unknown(file.byteSize, "font family or style metadata is missing");
      }
      return ok({
        status: "ok",
        kind: "font",
        byteSize: file.byteSize,
        family: font.familyName,
        style: font.subfamilyName,
      });
    } catch {
      return unknown(file.byteSize, "font metadata could not be read");
    }
  }
}
