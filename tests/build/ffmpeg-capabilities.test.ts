import { describe, expect, it } from "vitest";

import {
  FFMPEG_SOURCES,
  REQUIRED_DECODERS,
  REQUIRED_ENCODERS,
  ffmpegConfigureArgs,
} from "../../scripts/build-ffmpeg.mjs";

describe("packaged FFmpeg capabilities", () => {
  it("pins and enables the WebP encoder required by derived thumbnails", () => {
    expect(FFMPEG_SOURCES.libwebp).toEqual({
      version: "1.5.0",
      url: "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.5.0.tar.gz",
      sha256: "sha256:7d6fab70cf844bf6769077bd5d7a74893f8ffd4dfb42861745750c63c2a5c92c",
    });
    expect(ffmpegConfigureArgs("/private/runtime")).toContain("--enable-libwebp");
    expect(ffmpegConfigureArgs("/private/runtime")).toContain("--enable-zlib");
    expect(REQUIRED_ENCODERS).toContain("libwebp");
    expect(REQUIRED_DECODERS).toContain("png");
  });
});
