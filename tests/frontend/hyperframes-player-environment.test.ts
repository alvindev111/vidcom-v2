// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  previewHostUrl,
  previewSourceUrl,
} from "../../src/components/studio/hyperframes-player-environment";

describe("HyperFrames preview URL isolation", () => {
  it("loads relative preview documents through the isolated preview origin", () => {
    expect(previewSourceUrl(
      "http://preview.localhost:43121",
      "/api/preview/projects/project-1?changeSeq=2",
    )).toBe("http://preview.localhost:43121/api/preview/projects/project-1?changeSeq=2");
  });

  it("keeps the bridge host on the isolated origin while naming the parent origin", () => {
    const url = previewHostUrl(
      "http://preview.localhost:43121",
      "n".repeat(43),
      "http://127.0.0.1:43121",
    );
    expect(url).toContain("http://preview.localhost:43121/preview-host.html#");
    expect(url).toContain("parentOrigin=http%3A%2F%2F127.0.0.1%3A43121");
  });
});
