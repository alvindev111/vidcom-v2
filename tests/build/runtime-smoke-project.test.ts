import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceFs } from "@vidcom/adapter";
import type { AbsolutePath } from "@vidcom/core";
import { describe, expect, it } from "vitest";

import { writeRuntimeSmokeProject } from "../../scripts/runtime-smoke-project.mjs";

describe("Next runtime smoke project", () => {
  it("generates a real marker-backed project without a repository fixture directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-runtime-smoke-project-"));
    try {
      const workspace = path.join(root, "workspace");
      const generated = await writeRuntimeSmokeProject(workspace);
      const projects = await new WorkspaceFs(workspace as AbsolutePath).listProjects();
      expect(projects).toEqual([expect.objectContaining({ id: generated.id, slug: generated.slug })]);
      expect(await readFile(generated.entry, "utf8")).toContain('data-composition-src="compositions/scene-1.html"');
      expect(await readFile(path.join(generated.project, "preview-settings.json"), "utf8"))
        .toContain('"enabled": false');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
