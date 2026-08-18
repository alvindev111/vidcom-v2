// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  ASSET_POLICIES,
  detectAssetKind,
  matchesDeclaredKind,
} from "../../packages/core/src/domain/magic-bytes";
import { resolveCollision, sanitizeFilename } from "../../packages/core/src/domain/asset-names";

const ascii = (value: string) => new TextEncoder().encode(value);

describe("asset content policy", () => {
  it("detects the four declared kinds from content signatures rather than client MIME", () => {
    expect(detectAssetKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image");
    expect(detectAssetKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
    expect(detectAssetKind(ascii("GIF89a"))).toBe("image");
    expect(detectAssetKind(ascii("RIFF\0\0\0\0WEBP"))).toBe("image");
    expect(detectAssetKind(ascii(" \n<?xml version=\"1.0\"?><svg viewBox=\"0 0 1 1\">"))).toBe("image");

    expect(detectAssetKind(ascii("\0\0\0\u0018ftypisom"))).toBe("video");
    expect(detectAssetKind(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe("video");
    expect(detectAssetKind(ascii("ID3\u0004"))).toBe("audio");
    expect(detectAssetKind(ascii("RIFF\0\0\0\0WAVE"))).toBe("audio");
    expect(detectAssetKind(ascii("OggS"))).toBe("audio");
    expect(detectAssetKind(ascii("\0\0\0\u0018ftypM4A "))).toBe("audio");

    expect(detectAssetKind(ascii("wOFF"))).toBe("font");
    expect(detectAssetKind(ascii("wOF2"))).toBe("font");
    expect(detectAssetKind(Uint8Array.from([0x00, 0x01, 0x00, 0x00]))).toBe("font");
    expect(detectAssetKind(ascii("OTTO"))).toBe("font");
    expect(detectAssetKind(ascii("not an asset"))).toBeNull();
    expect(matchesDeclaredKind(ascii("ID3"), "image")).toBe(false);
    expect(matchesDeclaredKind(ascii("ID3"), "audio")).toBe(true);
  });

  it("publishes the approved per-kind limits and extension allowlists", () => {
    expect(ASSET_POLICIES).toEqual({
      image: { maxBytes: 25 * 1024 * 1024, extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] },
      video: { maxBytes: 500 * 1024 * 1024, extensions: ["mp4", "webm", "mov"] },
      audio: { maxBytes: 100 * 1024 * 1024, extensions: ["mp3", "wav", "m4a", "ogg"] },
      font: { maxBytes: 5 * 1024 * 1024, extensions: ["woff2", "woff", "ttf", "otf"] },
    });
  });
});

describe("asset filename policy", () => {
  it("drops path components and controls, normalizes NFC, and neutralizes OS-invalid names", () => {
    expect(sanitizeFilename("C:\\folder\\na<me>?.png")).toBe("na_me__.png");
    expect(sanitizeFilename("cafe\u0301\u0000.png")).toBe("café.png");
    expect(sanitizeFilename("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFilename(" ... ")).toBe("asset");
  });

  it("resolves collisions visibly and case-insensitively without overwriting", () => {
    const taken = new Set(["IMAGE.PNG", "image (2).png"]);
    expect(resolveCollision("image.png", taken)).toBe("image (3).png");
    expect(resolveCollision("fresh.png", taken)).toBe("fresh.png");
  });
});
