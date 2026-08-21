// @vitest-environment node

import { describe, expect, it } from "vitest";

import { missingMediaPaths } from "@/lib/studio/scene-media";
import type { Scene } from "@/lib/studio/types";

const scene = (media: Scene["media"]): Scene => ({
  id: "scene-1", src: "compositions/scene-1.html", start: 0, duration: 4, trackIndex: 0,
  block: null, isTransition: false, media, script: [], narration: null, elements: [], unresolvedEffects: 0,
});

describe("missingMediaPaths", () => {
  it("lists the sources a clip references but cannot find, without repeats", () => {
    const paths = missingMediaPaths(scene([
      { kind: "video", url: "/api/hf/p/files/assets/gone.mp4", src: "../assets/gone.mp4", start: 0, duration: 4, missing: true },
      { kind: "video", url: "/api/hf/p/files/assets/gone.mp4", src: "../assets/gone.mp4", start: 0, duration: 4, missing: true },
      { kind: "image", url: "/api/hf/p/files/assets/here.png", src: "../assets/here.png", start: null, duration: null, missing: false },
    ]));
    expect(paths).toEqual(["../assets/gone.mp4"]);
  });

  it("says nothing about a scene whose sources all resolve", () => {
    expect(missingMediaPaths(scene([
      { kind: "image", url: "/api/hf/p/files/assets/here.png", src: "../assets/here.png", start: null, duration: null, missing: false },
    ]))).toEqual([]);
  });
});
