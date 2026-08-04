import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  type AbsolutePath,
  type ClockPort,
  type JobId,
  type RenderRootPort,
  type ResolvedPath,
} from "@vidcom/core";

import { writeAtomic } from "./atomic-write";
import { syncDirectory } from "./durability";

export const RENDER_OWNER_MARKER = ".vidcom-render-owner";
export const RENDER_WORKDIR_ORPHAN_GRACE_SECONDS = 3600;

interface OwnerMarker {
  jobId: JobId;
  createdAt: string;
}

export interface FsRenderRootOptions {
  stagingRoot: AbsolutePath;
  ffmpegPath: AbsolutePath;
  ffprobePath: AbsolutePath;
  clock: ClockPort;
}

function validJobId(value: unknown): value is JobId {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

async function readMarker(root: string): Promise<OwnerMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, RENDER_OWNER_MARKER), "utf8")) as Partial<OwnerMarker>;
    if (!validJobId(parsed.jobId) || typeof parsed.createdAt !== "string"
      || !Number.isFinite(Date.parse(parsed.createdAt))) return null;
    return { jobId: parsed.jobId, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

/** Owns only marker-backed render roots beneath one app-data staging directory. */
export class FsRenderRootAdapter implements RenderRootPort {
  constructor(private readonly options: FsRenderRootOptions) {}

  async acquire(jobId: JobId): Promise<{ root: AbsolutePath; environment: Record<string, string> }> {
    if (!validJobId(jobId)) throw new TypeError("render job id is invalid");
    await mkdir(this.options.stagingRoot, { recursive: true, mode: 0o700 });
    const root = path.join(this.options.stagingRoot, jobId);
    await mkdir(root, { recursive: false, mode: 0o700 });
    const marker: OwnerMarker = { jobId, createdAt: this.options.clock.now().toISOString() };
    await writeAtomic(
      path.join(root, RENDER_OWNER_MARKER) as ResolvedPath,
      `${JSON.stringify(marker)}\n`,
    );
    await syncDirectory(root);
    await syncDirectory(this.options.stagingRoot);
    return {
      root: root as AbsolutePath,
      environment: {
        TEMP: root,
        TMP: root,
        HYPERFRAMES_FFMPEG_PATH: this.options.ffmpegPath,
        HYPERFRAMES_FFPROBE_PATH: this.options.ffprobePath,
      },
    };
  }

  async release(jobId: JobId): Promise<{ ok: boolean; error?: string }> {
    if (!validJobId(jobId)) return { ok: false, error: "render job id is invalid" };
    const root = path.join(this.options.stagingRoot, jobId);
    const marker = await readMarker(root);
    if (!marker || marker.jobId !== jobId) {
      return { ok: false, error: "render root ownership marker is missing or invalid" };
    }
    try {
      await rm(root, { recursive: true, force: true });
      await syncDirectory(this.options.stagingRoot);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "render root release failed" };
    }
  }

  async inspect(jobId: JobId): Promise<"absent" | "owned" | "unowned"> {
    if (!validJobId(jobId)) return "unowned";
    const root = path.join(this.options.stagingRoot, jobId);
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return "unowned";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    const marker = await readMarker(root);
    return marker?.jobId === jobId ? "owned" : "unowned";
  }

  async reclaimOrphans(
    now: Date,
    runningJobIds: ReadonlySet<JobId>,
  ): Promise<{ deleted: number; reclaimedJobIds: JobId[]; errors: Array<{ root: string; reason: string }> }> {
    const reclaimedJobIds: JobId[] = [];
    const errors: Array<{ root: string; reason: string }> = [];
    let entries;
    try {
      entries = await readdir(this.options.stagingRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { deleted: 0, reclaimedJobIds, errors };
      }
      return {
        deleted: 0,
        reclaimedJobIds,
        errors: [{ root: this.options.stagingRoot, reason: error instanceof Error ? error.message : "scan failed" }],
      };
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !validJobId(entry.name)) continue;
      const root = path.join(this.options.stagingRoot, entry.name);
      const marker = await readMarker(root);
      if (!marker || marker.jobId !== entry.name) continue;
      if (runningJobIds.has(marker.jobId)) continue;
      const ageMs = now.getTime() - Date.parse(marker.createdAt);
      if (ageMs < RENDER_WORKDIR_ORPHAN_GRACE_SECONDS * 1000) continue;
      try {
        await rm(root, { recursive: true, force: true });
        reclaimedJobIds.push(marker.jobId);
      } catch (error) {
        errors.push({ root, reason: error instanceof Error ? error.message : "remove failed" });
      }
    }
    if (reclaimedJobIds.length > 0) await syncDirectory(this.options.stagingRoot).catch((error) => {
      errors.push({
        root: this.options.stagingRoot,
        reason: error instanceof Error ? error.message : "directory sync failed",
      });
    });
    return { deleted: reclaimedJobIds.length, reclaimedJobIds, errors };
  }
}
