import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type ProjectId, type RelPath } from "@vidcom/contracts";
import { type AbsolutePath, type ProjectRef } from "@vidcom/core";
import { createInfrastructure } from "@vidcom/cli";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production dependency invalidation wiring", () => {
  it("fans committed and watched paths into the live dependency graph consumer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-dependency-wiring-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    await mkdir(path.join(projectRoot, "media"), { recursive: true });
    await writeFile(path.join(projectRoot, "index.html"), `<main data-composition-id="main"><div data-composition-id="scene-a" data-composition-src="scene.html"></div></main>`);
    await writeFile(path.join(projectRoot, "scene.html"), `<template><section data-composition-id="scene-a"><img src="media/poster.png"></section></template>`);
    await writeFile(path.join(projectRoot, "media/poster.png"), "first");
    const infrastructure = createInfrastructure({
      appDataRoot: path.join(root, "app-data"),
      workspaceRoot: workspaceRoot as AbsolutePath,
    });
    const ref: ProjectRef = {
      id: "project_dependency_wiring" as ProjectId,
      slug: "project",
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };

    expect(infrastructure.thumbnailScheduler.status).toEqual({ active: 0, queued: 0 });
    expect(infrastructure.thumbnailCache).toBeDefined();

    const first = await infrastructure.dependencyGraph.dependenciesOf(ref, "scene-a");
    expect(first.ok && first.value[0]?.contentHash).toBeTruthy();
    await writeFile(path.join(projectRoot, "media/poster.png"), "second");
    const stale = await infrastructure.dependencyGraph.dependenciesOf(ref, "scene-a");
    expect(stale).toEqual(first);

    infrastructure.pathInvalidator.invalidate(ref.id, ["media/poster.png" as RelPath]);
    const refreshed = await infrastructure.dependencyGraph.dependenciesOf(ref, "scene-a");
    expect(refreshed).not.toEqual(first);
    await infrastructure.database.destroy();
  });
});
