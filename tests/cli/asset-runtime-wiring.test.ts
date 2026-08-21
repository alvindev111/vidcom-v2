import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FsAssetStaging, NodeAssetProbe } from "@vidcom/adapter";
import { createInfrastructure, startVidcomFoundation } from "@vidcom/cli";
import type { ProjectId } from "@vidcom/contracts";
import type { AbsolutePath, ProcessPort } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(workspace: string, slug: string, projectId: ProjectId) {
  const root = path.join(workspace, slug);
  await mkdir(path.join(root, ".vidcom", "tmp"), { recursive: true });
  await writeFile(path.join(root, "hyperframes.json"), "{}\n");
  await writeFile(path.join(root, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`);
  await writeFile(path.join(root, "index.html"), '<main data-composition-id="root"></main>');
  return root;
}

describe("asset runtime wiring", () => {
  it("wires the resolved ffprobe path and bounded staging into production infrastructure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-asset-wiring-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot);
    const processes: ProcessPort = {
      async run() { return { exitCode: 1, stdout: "", stderr: "", timedOut: false }; },
    };
    const ffprobePath = path.join(root, "runtime", "ffprobe") as AbsolutePath;
    const infrastructure = createInfrastructure({
      appDataRoot: path.join(root, "app-data"),
      workspaceRoot: workspaceRoot as AbsolutePath,
      renderBinaryPaths: {
        ffmpegPath: path.join(root, "runtime", "ffmpeg") as AbsolutePath,
        ffprobePath,
      },
      processes,
    });
    try {
      expect(infrastructure.assetStaging).toBeInstanceOf(FsAssetStaging);
      expect(infrastructure.assetProbe).toBeInstanceOf(NodeAssetProbe);
      expect(infrastructure.assetProbe).toMatchObject({ processes, ffprobePath });
    } finally {
      await infrastructure.database.destroy();
    }
  });

  it("removes expired asset temp files before listener and logs cleanup failures without blocking boot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-asset-cleanup-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const appDataRoot = path.join(root, "app-data");
    await mkdir(workspaceRoot);
    const cleanProject = await project(workspaceRoot, "clean", "project_asset_clean" as ProjectId);
    const brokenProject = await project(workspaceRoot, "broken", "project_asset_broken" as ProjectId);
    const stale = path.join(cleanProject, ".vidcom", "tmp", "asset-stale.tmp");
    await writeFile(stale, "stale");
    await utimes(stale, new Date("2026-08-16T00:00:00.000Z"), new Date("2026-08-16T00:00:00.000Z"));
    await rm(path.join(brokenProject, ".vidcom", "tmp"), { recursive: true });
    await writeFile(path.join(brokenProject, ".vidcom", "tmp"), "not a directory");
    const warnings: Array<{ message: string; detail?: Record<string, unknown> }> = [];
    let listenerOpened = false;

    const runtime = await startVidcomFoundation({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
      holderId: "test:asset-cleanup",
      clock: { now: () => new Date("2026-08-18T12:00:00.000Z") },
      logger: {
        warn(message, detail) { warnings.push({ message, detail }); },
        error() {},
      },
    }, {
      async recoverJobs() {},
      async startScheduler() {},
      async startWatcher() {},
      async openListener() {
        await expect(access(stale)).rejects.toThrow();
        listenerOpened = true;
        return null;
      },
    });
    try {
      expect(listenerOpened).toBe(true);
      expect(warnings).toContainEqual({
        message: "asset staging cleanup failed",
        detail: expect.objectContaining({
          code: "asset_staging_cleanup_failed",
          projectId: "project_asset_broken",
        }),
      });
    } finally {
      await runtime.stop();
    }
  });
});
