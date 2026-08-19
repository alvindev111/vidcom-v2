import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase } from "@vidcom/adapter";
import { createInfrastructure } from "@vidcom/cli";
import { type ProjectId } from "@vidcom/contracts";
import { type AbsolutePath } from "@vidcom/core";

import { dbRun } from "../support/database";

const roots: string[] = [];
const projectId = "project_shared_css" as ProjectId;
const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition was not observed before timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-thumbnail-invalidation-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "shared");
  await mkdir(path.join(projectRoot, "scenes"), { recursive: true });
  await mkdir(path.join(projectRoot, "styles"), { recursive: true });
  await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`, "utf8");
  await writeFile(
    path.join(projectRoot, "index.html"),
    `<!doctype html><html><head></head><body>`
    + `<main data-composition-id="main" data-start="0" data-duration="4"`
    + ` data-width="1920" data-height="1080" data-fps="30">`
    + `<section data-composition-id="scene-a" data-composition-src="scenes/a.html"`
    + ` data-start="0" data-duration="2"></section>`
    + `<section data-composition-id="scene-b" data-composition-src="scenes/b.html"`
    + ` data-start="2" data-duration="2"></section>`
    + `</main></body></html>\n`,
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, "scenes", "a.html"),
    `<template><section data-composition-id="scene-a">`
    + `<link rel="stylesheet" href="../styles/shared.css"><p>a</p></section></template>\n`,
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, "scenes", "b.html"),
    `<template><section data-composition-id="scene-b">`
    + `<link rel="stylesheet" href="../styles/only-b.css"><p>b</p></section></template>\n`,
    "utf8",
  );
  await writeFile(path.join(projectRoot, "styles", "shared.css"), ".shared { color: red }\n", "utf8");
  await writeFile(path.join(projectRoot, "styles", "only-b.css"), ".only-b { color: blue }\n", "utf8");
  const infrastructure = createInfrastructure({
    appDataRoot: path.join(root, "app-data"),
    workspaceRoot: workspaceRoot as AbsolutePath,
  });
  await migrateDatabase(infrastructure.database);
  const stamp = "2026-08-19T00:00:00.000Z";
  dbRun(
    infrastructure.database,
    `INSERT INTO project_registry (id, workspace_root, slug, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)`,
    projectId,
    workspaceRoot,
    "shared",
    stamp,
    stamp,
  );
  return { infrastructure, projectRoot };
}

describe("external shared-CSS writes and thumbnail invalidation", () => {
  it("invalidates only the scenes that depend on the changed shared stylesheet", async () => {
    const { infrastructure, projectRoot } = await fixture();
    const { thumbnailCache, thumbnailService, watcher, workspace } = infrastructure;
    const ref = (await workspace.listProjects()).find((candidate) => candidate.id === projectId)!;
    const request = (sceneId: string) => ({ sceneId, atSeconds: [0.5], profile: "timeline-v1" as const });
    const planned = {
      a: await thumbnailService.plan(ref, request("scene-a")),
      b: await thumbnailService.plan(ref, request("scene-b")),
    };
    expect(planned.a.ok && planned.b.ok).toBe(true);
    if (!planned.a.ok || !planned.b.ok) return;
    const fingerprints = { a: planned.a.value.fingerprint, b: planned.b.value.fingerprint };
    const warmed = {
      a: thumbnailService.renderKey(planned.a.value.keys[0]!),
      b: thumbnailService.renderKey(planned.b.value.keys[0]!),
    };
    expect(warmed.a).not.toBe(warmed.b);
    await thumbnailCache.put(ref.id, warmed.a, bytes);
    await thumbnailCache.put(ref.id, warmed.b, bytes);

    await watcher.start();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await writeFile(path.join(projectRoot, "styles", "shared.css"), ".shared { color: green }\n", "utf8");
      await eventually(async () => {
        const current = await thumbnailService.isFingerprintCurrent(ref, "scene-a", fingerprints.a);
        return current.ok && !current.value;
      });
    } finally {
      watcher.close();
    }

    await expect(thumbnailService.isFingerprintCurrent(ref, "scene-b", fingerprints.b))
      .resolves.toEqual({ ok: true, value: true });
    const replanned = {
      a: await thumbnailService.plan(ref, request("scene-a")),
      b: await thumbnailService.plan(ref, request("scene-b")),
    };
    expect(replanned.a.ok && replanned.b.ok).toBe(true);
    if (!replanned.a.ok || !replanned.b.ok) return;
    const rekeyed = {
      a: thumbnailService.renderKey(replanned.a.value.keys[0]!),
      b: thumbnailService.renderKey(replanned.b.value.keys[0]!),
    };
    expect(rekeyed.a).not.toBe(warmed.a);
    expect(rekeyed.b).toBe(warmed.b);
    await expect(thumbnailCache.get(ref.id, rekeyed.a)).resolves.toBeNull();
    await expect(thumbnailCache.get(ref.id, rekeyed.b)).resolves.toEqual(bytes);
    await expect(infrastructure.events.readFrom(0, 10)).resolves.toMatchObject({
      events: [{
        type: "file.changed",
        projectId,
        payload: { path: "styles/shared.css", source: "external" },
      }],
    });

    await infrastructure.database.destroy();
  });
});
