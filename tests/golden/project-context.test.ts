import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { serializeProjectContext, type ProjectContext } from "@vidcom/core";

describe("project context golden", () => {
  it("is deterministic and contains no machine-local metadata", async () => {
    const context: ProjectContext = {
      slug: "delivery-loop",
      state: "authored",
      platform: {
        presetId: "vertical-shorts",
        orientation: "vertical",
        aspectRatio: "9:16",
        width: 1080,
        height: 1920,
        fps: 30,
        targets: ["tiktok", "youtube-shorts"],
        recommendedMaxDurationSeconds: 180,
      },
      sceneCount: 2,
      durationSeconds: 7,
      scenes: [
        { id: "scene-b", start: 3, duration: 4, trackIndex: 1 },
        { id: "scene-a", start: 0, duration: 3, trackIndex: 0 },
      ],
      narration: { cueCount: 1, staleSceneIds: ["scene-b"] },
      openIssues: ["missing-alt-text"],
    };
    const actual = serializeProjectContext(context);
    const expected = await readFile(new URL("./fixtures/project-context.md", import.meta.url), "utf8");
    expect(actual).toBe(expected);
    expect(actual).not.toMatch(/(?:\/Users\/|[A-Z]:\\|job_|2026-\d{2}-\d{2}T)/u);
    expect(serializeProjectContext(context)).toBe(actual);
  });
});
