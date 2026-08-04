import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId } from "@vidcom/contracts";
import {
  FsRenderRootAdapter,
  initializeDatabase,
  RENDER_OWNER_MARKER,
  RENDER_WORKDIR_ORPHAN_GRACE_SECONDS,
  SqliteJobStore,
} from "@vidcom/adapter";
import { canonicalizeJobInput, type AbsolutePath, type JobId } from "@vidcom/core";
import { dbRun } from "../support/database";

const roots: string[] = [];
const hash = (value: unknown): ContentHash =>
  `sha256:${createHash("sha256").update(canonicalizeJobInput(value)).digest("hex")}` as ContentHash;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(createdAt = "2026-08-04T00:00:00.000Z") {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-render-root-"));
  roots.push(root);
  const stagingRoot = path.join(root, "render-roots") as AbsolutePath;
  const adapter = new FsRenderRootAdapter({
    stagingRoot,
    ffmpegPath: path.join(root, "bin", "ffmpeg") as AbsolutePath,
    ffprobePath: path.join(root, "bin", "ffprobe") as AbsolutePath,
    clock: { now: () => new Date(createdAt) },
  });
  return { root, stagingRoot, adapter };
}

async function marker(root: string, jobId: JobId, createdAt: string) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, RENDER_OWNER_MARKER), `${JSON.stringify({ jobId, createdAt })}\n`);
}

describe("FsRenderRootAdapter with real filesystem", () => {
  it("locks the orphan grace period and returns a complete process environment", async () => {
    expect(RENDER_WORKDIR_ORPHAN_GRACE_SECONDS).toBe(3600);
    const { adapter } = await fixture();
    const acquired = await adapter.acquire("job_environment" as JobId);
    expect(acquired.environment).toEqual({
      TEMP: acquired.root,
      TMP: acquired.root,
      HYPERFRAMES_FFMPEG_PATH: expect.stringContaining("ffmpeg"),
      HYPERFRAMES_FFPROBE_PATH: expect.stringContaining("ffprobe"),
    });
    expect(JSON.parse(await readFile(path.join(acquired.root, RENDER_OWNER_MARKER), "utf8")))
      .toEqual({ jobId: "job_environment", createdAt: "2026-08-04T00:00:00.000Z" });
    expect(await adapter.release("job_environment" as JobId)).toEqual({ ok: true });
    await expect(access(acquired.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists cleanupPending on release failure, reclaims later, then clears it", async () => {
    const { root, adapter } = await fixture("2026-08-04T00:00:00.000Z");
    const id = "job_cleanup" as JobId;
    const acquired = await adapter.acquire(id);
    await writeFile(path.join(acquired.root, RENDER_OWNER_MARKER), "not-json");
    expect(await adapter.release(id)).toMatchObject({ ok: false });

    const database = await initializeDatabase(path.join(root, "app-data"));
    try {
      dbRun(database, `INSERT INTO project_registry
        (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
      "project_cleanup", root, "project", "2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
      const store = new SqliteJobStore(database, { now: () => new Date("2026-08-04T00:00:00.000Z") });
      await store.enqueue({
        id,
        projectId: "project_cleanup" as ProjectId,
        type: "render",
        input: {},
        inputHash: hash({}),
        idempotencyKey: null,
      });
      expect(await store.claim(id, "worker")).toBe(true);
      expect(await store.finish(id, { status: "succeeded", result: {}, cleanupPending: true })).toBe(true);
      expect((await store.get(id))?.cleanupPending).toBe(true);

      await writeFile(path.join(acquired.root, RENDER_OWNER_MARKER), `${JSON.stringify({
        jobId: id,
        createdAt: "2026-08-03T22:00:00.000Z",
      })}\n`);
      const reclaimed = await adapter.reclaimOrphans(new Date("2026-08-04T00:00:00.000Z"), new Set());
      expect(reclaimed).toEqual({ deleted: 1, reclaimedJobIds: [id], errors: [] });
      for (const reclaimedId of reclaimed.reclaimedJobIds) {
        expect(await store.clearCleanupPending(reclaimedId)).toBe(true);
      }
      expect((await store.get(id))?.cleanupPending).toBe(false);
    } finally {
      await database.destroy();
    }
  });

  it.each([
    "outside-staging",
    "missing-marker",
    "younger-than-grace",
    "running-job",
  ] as const)("retains a root when the %s orphan condition is missing", async (missing) => {
    const { root, stagingRoot, adapter } = await fixture("2026-08-03T22:00:00.000Z");
    await mkdir(stagingRoot, { recursive: true });
    const jobId = `job_${missing.replaceAll("-", "_")}` as JobId;
    const target = missing === "outside-staging"
      ? path.join(root, "outside", jobId)
      : path.join(stagingRoot, jobId);
    if (missing === "missing-marker") await mkdir(target, { recursive: true });
    else await marker(
      target,
      jobId,
      missing === "younger-than-grace"
        ? "2026-08-03T23:30:01.000Z"
        : "2026-08-03T22:00:00.000Z",
    );
    const running = missing === "running-job" ? new Set([jobId]) : new Set<JobId>();

    expect(await adapter.reclaimOrphans(new Date("2026-08-04T00:00:00.000Z"), running))
      .toEqual({ deleted: 0, reclaimedJobIds: [], errors: [] });
    await expect(access(target)).resolves.toBeUndefined();
  });

  it("reclaims a crashed render root only after all four orphan conditions hold", async () => {
    const { root, adapter } = await fixture("2026-08-03T22:00:00.000Z");
    const jobId = "job_crashed_render" as JobId;
    const acquired = await adapter.acquire(jobId);
    await writeFile(path.join(acquired.root, "output.mp4"), "staged-only");
    const published = path.join(root, "project", "renders", `${jobId}.mp4`);

    await expect(access(published)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await adapter.inspect(jobId)).toBe("owned");
    const reclaimed = await adapter.reclaimOrphans(
      new Date("2026-08-04T00:00:00.000Z"),
      new Set<JobId>(),
    );
    expect(reclaimed).toEqual({ deleted: 1, reclaimedJobIds: [jobId], errors: [] });
    expect(await adapter.inspect(jobId)).toBe("absent");
    await expect(access(acquired.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(published)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
