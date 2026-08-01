import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";
import { applyCompositionOps } from "@vidcom/adapter";
import type { AbsolutePath } from "@vidcom/core";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Serialize a committed project entry through the same SDK used by the editor.
 *
 * Opening and serializing parses and re-emits the complete document. The
 * composition is disposed even when the serializer throws so test runs do not
 * retain SDK state across fixtures.
 */
async function serializeProject(slug: string): Promise<string> {
  const result = await applyCompositionOps({
    id: slug as ProjectId,
    slug,
    root: path.join(REPOSITORY_ROOT, "projects", slug) as AbsolutePath,
    entry: "index.html" as RelPath,
  }, "index.html" as RelPath, []);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("HyperFrames composition serialization", () => {
  it("keeps the reviewed warm-grain output stable", async () => {
    await expect(serializeProject("warm-grain")).resolves.toMatchFileSnapshot(
      "../../fixtures/serialize/warm-grain-expected.html",
    );
  });

  it("locks the first SDK rewrite of swiss-grid", async () => {
    await expect(serializeProject("swiss-grid")).resolves.toMatchFileSnapshot(
      "../../fixtures/serialize/swiss-grid-expected.html",
    );
  });
});
