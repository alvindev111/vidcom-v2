import { describe, expect, it } from "vitest";

import { ErrorCode, type RelPath } from "@vidcom/contracts";
import {
  assertCatalogEncodable,
  buildNarrationClips,
  inferPreset,
  PLATFORM_PRESETS,
  readCues,
  scanExternalDependencies,
  scanRemoteMedia,
  validateCustom,
} from "@vidcom/core";

const rel = (value: string) => value as RelPath;

describe("platform preset catalog", () => {
  it("contains only encodable bundled dimensions", () => {
    expect(() => assertCatalogEncodable()).not.toThrow();
    expect(() => assertCatalogEncodable([{ ...PLATFORM_PRESETS[0]!, width: 1081 }])).toThrow(/even dimensions/);
  });

  it("infers exact presets and preserves unknown dimensions as custom", () => {
    expect(inferPreset(1080, 1920, 30)).toMatchObject({ presetId: "vertical-shorts" });
    expect(inferPreset(1080, 1920, 30).targets).toContain("tiktok");
    expect(inferPreset(1000, 1000, 24)).toEqual({
      presetId: "custom", orientation: "horizontal", aspectRatio: "1:1",
      width: 1000, height: 1000, fps: 24, targets: [], recommendedMaxDurationSeconds: null,
    });
  });

  it.each([
    [{ width: 127, height: 720, fps: 30 }, "width"],
    [{ width: 1081, height: 1920, fps: 30 }, "width"],
    [{ width: 1080, height: 7682, fps: 30 }, "height"],
    [{ width: 1080, height: 1920, fps: 0 }, "fps"],
    [{ width: 1080, height: 1920, fps: 121 }, "fps"],
  ] as const)("rejects invalid custom bounds %#", (input, field) => {
    expect(validateCustom(input)).toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid, field } });
  });

  it("derives a valid custom orientation and reduced aspect ratio", () => {
    expect(validateCustom({ width: 1440, height: 1080, fps: 60 })).toEqual({
      ok: true,
      value: {
        presetId: "custom", orientation: "horizontal", aspectRatio: "4:3",
        width: 1440, height: 1080, fps: 60, targets: [], recommendedMaxDurationSeconds: null,
      },
    });
  });
});

describe("narration cues", () => {
  it("maps a legacy sidecar to exactly one cue without rewriting it", () => {
    const legacy = {
      sceneId: "intro", text: "Xin chào", voice: "minh-duc", durationSeconds: 2.5,
      staleSince: null, audioPath: "narration/intro.wav",
    };
    const before = JSON.stringify(legacy);
    expect(readCues(legacy)).toEqual([{
      cueId: "intro", text: "Xin chào", voice: "minh-duc", offsetSeconds: 0,
      durationSeconds: 2.5, staleSince: null,
    }]);
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it("builds one clip per cue from the document scene start", () => {
    const cues = readCues({ cues: [
      { cueId: "line-1", text: "Một", voice: "a", offsetSeconds: 0, durationSeconds: 1, staleSince: null },
      { cueId: "line-2", text: "Hai", voice: "b", offsetSeconds: 1.5, durationSeconds: 2, staleSince: null },
    ] });
    expect(buildNarrationClips({ sceneId: "intro", start: 4, duration: 8, trackIndex: 0 }, cues)).toEqual([
      { sceneId: "intro", cueId: "line-1", startSeconds: 4, durationSeconds: 1 },
      { sceneId: "intro", cueId: "line-2", startSeconds: 5.5, durationSeconds: 2 },
    ]);
  });
});

describe("static remote asset scan", () => {
  it("finds remote media in element attributes, inline CSS, and local stylesheets", () => {
    expect(scanRemoteMedia([
      { path: rel("index.html"), html: '<img src="https://cdn.example/hero.png"><style>.a{background:url(//cdn.example/a.jpg)}</style>' },
    ], [
      { path: rel("styles/main.css"), css: '.b{background-image:url("https://cdn.example/b.webp")}' },
    ])).toMatchObject([
      { url: "https://cdn.example/hero.png", source: "element-attribute" },
      { url: "//cdn.example/a.jpg", source: "css-url" },
      { url: "https://cdn.example/b.webp", source: "css-url", reference: "styles/main.css" },
    ]);
  });

  it("reports scripts, stylesheets and fonts as external dependencies without media violations", () => {
    const documents = [{
      path: rel("index.html"),
      html: '<script src="https://cdn.example/app.js"></script><link rel="stylesheet" href="https://cdn.example/app.css"><link rel="preload" as="font" href="https://cdn.example/font.woff2">',
    }];
    const stylesheets = [{
      path: rel("styles/fonts.css"),
      css: '@font-face{src:url("https://cdn.example/voice.woff2")} @import url("https://cdn.example/base.css");',
    }];
    expect(scanRemoteMedia(documents, stylesheets)).toEqual([]);
    expect(scanExternalDependencies(documents, stylesheets)).toEqual([
      "https://cdn.example/app.css",
      "https://cdn.example/app.js",
      "https://cdn.example/base.css",
      "https://cdn.example/font.woff2",
      "https://cdn.example/voice.woff2",
    ]);
  });
});
