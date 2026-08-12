import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";
import { applyCompositionOps } from "@vidcom/adapter";
import type { AbsolutePath } from "@vidcom/core";

import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Parse and re-emit a project through the same SDK the editor uses.
 *
 * The value is the round trip: an SDK upgrade that reorders attributes, drops a
 * `data-*`, or rewrites whitespace shows up here as a diff before it shows up as
 * a broken render. The input is generated rather than committed so the fixture
 * cannot drift from what the product itself writes.
 */
async function serializeSample(shape: { width: number; height: number }): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "vidcom-serialize-"));
  roots.push(workspace);
  const sample = await writeSampleProject(workspace, { slug: "sample", ...shape });
  const result = await applyCompositionOps({
    id: "project_serialize" as ProjectId,
    slug: sample.slug,
    root: sample.root as AbsolutePath,
    entry: sample.entry as RelPath,
  }, sample.entry as RelPath, []);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("HyperFrames composition serialization", () => {
  it("keeps the landscape round trip stable", async () => {
    await expect(serializeSample({ width: 1920, height: 1080 })).resolves.toMatchFileSnapshot(
      "../../fixtures/serialize/landscape-expected.html",
    );
  });

  it("keeps the portrait round trip stable", async () => {
    await expect(serializeSample({ width: 1080, height: 1920 })).resolves.toMatchFileSnapshot(
      "../../fixtures/serialize/portrait-expected.html",
    );
  });
});
