import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapSnapshotArtifacts } from "@vidcom/worker";

describe("snapshot timestamp mapping golden", () => {
  it("locks numeric timestamp mapping independently of output ordinal", async () => {
    const result = mapSnapshotArtifacts([
      { id: "one", midpoint: 1 },
      { id: "one-half", midpoint: 1.5 },
      { id: "three", midpoint: 3 },
    ], [
      { name: "frame-00-at-1.0s.png", content: new Uint8Array([1]) },
      { name: "frame-01-at-3s.png", content: new Uint8Array([3]) },
    ]);
    const serializable = {
      captured: [...result.images].map(([sceneId, content]) => ({ sceneId, bytes: [...content] })),
      missingSceneIds: result.missingSceneIds,
    };
    const expected = JSON.parse(await readFile(
      path.resolve("tests/golden/fixtures/snapshot-timestamp-mapping.json"),
      "utf8",
    ));
    expect(serializable).toEqual(expected);
  });
});
