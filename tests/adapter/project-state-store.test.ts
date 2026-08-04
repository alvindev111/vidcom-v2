import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AppDataAssetStager,
  initializeDatabase,
  SqliteJobStore,
  LargePreviousContentStore,
  MutationJournal,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  ProjectStateStore,
  WriteAuthority,
  isStale,
  type AbsolutePath,
  type ClockPort,
  type JobId,
  type ProjectContext,
  type ProjectRef,
  type ProjectStateFile,
} from "@vidcom/core";

import { createSequentialIdPort } from "../support/deterministic";
import { dbOne, dbRun } from "../support/database";

const now = "2026-08-04T12:00:00.000Z";
const clock: ClockPort = { now: () => new Date(now) };
const projectId = "project_state_store" as ProjectId;
const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

let root: string;
let workspaceRoot: string;
let projectRoot: string;
let appDataRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let workspace: WorkspaceFs;
let journal: MutationJournal;
let jobs: SqliteJobStore;
let authority: WriteAuthority;
let ref: ProjectRef;
let store: ProjectStateStore;

async function run(command: string[], cwd = projectRoot): Promise<string> {
  const { stdout } = await promisify(execFile)(command[0]!, command.slice(1), { cwd });
  return stdout;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-project-state-"));
  workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  appDataRoot = path.join(root, "app-data");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "vidcom.json"), '{"id":"project_state_store"}\n');
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "index.html"), "source-0");
  database = await initializeDatabase(appDataRoot);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, workspaceRoot, "project", now, now);
  workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
  journal = new MutationJournal(database, clock, new LargePreviousContentStore(appDataRoot));
  jobs = new SqliteJobStore(database, clock);
  const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:state-store");
  if (!acquired.ok) throw new Error("lease denied");
  authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease,
    leaseId: acquired.leaseId,
    hashContent: hash,
    stagedAssets: new AppDataAssetStager(appDataRoot),
    invalidate() {},
    notifyEvents() {},
  });
  ref = {
    id: projectId,
    slug: "project",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  store = new ProjectStateStore({ workspace, authority, journal, jobs, clock, actor: "system" });
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("ProjectStateStore on real SQLite and filesystem", () => {
  it("keeps only deterministic context trackable while state, jobs, revisions, and logs stay ignored", async () => {
    await run(["git", "init", "--quiet"]);
    await store.ensure(ref);
    for (const directory of ["context", "jobs", "revisions", "logs", "cache"]) {
      await expect(access(path.join(projectRoot, ".vidcom", directory))).resolves.toBeUndefined();
    }
    const context: ProjectContext = {
      slug: "project",
      state: "authored",
      platform: {
        presetId: "vertical-shorts",
        orientation: "vertical",
        aspectRatio: "9:16",
        width: 1080,
        height: 1920,
        fps: 30,
        targets: ["tiktok"],
        recommendedMaxDurationSeconds: 180,
      },
      sceneCount: 1,
      durationSeconds: 4,
      scenes: [{ id: "scene-1", start: 0, duration: 4, trackIndex: 0 }],
      narration: { cueCount: 0, staleSceneIds: [] },
      openIssues: [],
    };
    const first = await store.writeContext(ref, context);
    expect(first.ok).toBe(true);
    const firstBytes = await readFile(path.join(projectRoot, ".vidcom/context/project-context.md"));
    expect((await store.writeContext(ref, context)).ok).toBe(true);
    expect(await readFile(path.join(projectRoot, ".vidcom/context/project-context.md"))).toEqual(firstBytes);
    const state: ProjectStateFile = {
      schemaVersion: 1,
      projectId,
      state: "authored",
      sceneCount: 1,
      lastOpenedAt: now,
      sourceRevision: 0,
      snapshots: {
        complete: false,
        computedAtSourceRevision: null,
        partialAtSourceRevision: null,
        missingSceneIds: [],
        sceneCount: 1,
        sceneIds: [],
        snapshotPaths: {},
        contactSheet: null,
      },
      lastRender: null,
      diagnostics: null,
      pendingRecovery: [],
    };
    expect((await store.writeState(ref, state)).ok).toBe(true);
    await store.log(ref, {
      at: now,
      level: "info",
      message: "safe",
      detail: { apiKey: "DO_NOT_LEAK", authorization: "Bearer secret", count: 1 },
    });
    const log = await readFile(path.join(projectRoot, ".vidcom/logs/2026-08-04.jsonl"), "utf8");
    expect(log).not.toContain("DO_NOT_LEAK");
    expect(log).not.toContain("Bearer secret");
    expect(log).toContain("[REDACTED]");
    expect(await run(["git", "check-ignore", ".vidcom/state.json"])).toContain(".vidcom/state.json");
    expect(await run(["git", "check-ignore", ".vidcom/logs/2026-08-04.jsonl"])).toContain(".vidcom/logs/2026-08-04.jsonl");
    await expect(run(["git", "check-ignore", ".vidcom/context/project-context.md"]))
      .rejects.toMatchObject({ code: 1 });
    const status = await run(["git", "status", "--short", "--untracked-files=all"]);
    expect(status).toContain(".vidcom/.gitignore");
    expect(status).toContain(".vidcom/context/project-context.md");
    expect(status).not.toContain("state.json");
    expect(status).not.toContain("logs/");
  });

  it("rebuilds projections one-way from SQLite and derives staleness without storing a flag", async () => {
    const source = await authority.mutateSource({
      kind: "file",
      ref,
      path: "index.html" as RelPath,
      content: "source-1",
      expectedContentHash: hash("source-0"),
    }, "user");
    expect(source.ok).toBe(true);
    const enqueued = await jobs.enqueue({
      id: "job_snapshot_state" as JobId,
      projectId,
      type: "snapshot",
      input: { projectId },
      inputHash: hash("snapshot"),
      idempotencyKey: null,
    });
    if ("conflict" in enqueued) throw new Error("unexpected enqueue conflict");
    expect(await jobs.claim(enqueued.job.id as JobId, "worker-test")).toBe(true);
    expect(await jobs.finish(enqueued.job.id as JobId, {
      status: "partial",
      result: {
        complete: false,
        computedAtSourceRevision: null,
        partialAtSourceRevision: 1,
        missingSceneIds: ["scene-2"],
        sceneCount: 2,
      },
    })).toBe(true);
    await mkdir(path.join(projectRoot, ".vidcom/jobs"), { recursive: true });
    await writeFile(path.join(projectRoot, ".vidcom/jobs/index.jsonl"), '{"fake":"projection-must-not-win"}\n');
    const beforeJobs = dbOne<{ count: number }>(database, "SELECT COUNT(*) AS count FROM job")!.count;
    const report = await store.reconcile(ref);
    expect(report).toMatchObject({ rebuilt: true, jobsChanged: true, revisionsChanged: true });
    expect(dbOne<{ count: number }>(database, "SELECT COUNT(*) AS count FROM job")!.count).toBe(beforeJobs);
    const projectedJobs = await readFile(path.join(projectRoot, ".vidcom/jobs/index.jsonl"), "utf8");
    expect(projectedJobs).toContain("job_snapshot_state");
    expect(projectedJobs).not.toContain("projection-must-not-win");
    const persisted = JSON.parse(await readFile(path.join(projectRoot, ".vidcom/state.json"), "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain('"stale"');
    expect(isStale(null, 1)).toBe(false);
    expect(isStale(0, 1)).toBe(true);
    expect(await journal.latestSourceRevision(projectId)).toBe(1);
  });

  it("rejects persisted stale and validates log retention bounds", async () => {
    const invalid = {
      schemaVersion: 1,
      projectId,
      state: "authored",
      sceneCount: 0,
      lastOpenedAt: now,
      sourceRevision: 1,
      snapshots: { complete: false, computedAtSourceRevision: null, partialAtSourceRevision: null, missingSceneIds: [], sceneCount: 0, stale: true },
      lastRender: null,
      diagnostics: null,
      pendingRecovery: [],
    } as unknown as ProjectStateFile;
    expect(await store.writeState(ref, invalid)).toMatchObject({ ok: false, error: { field: "stale" } });
    await expect(store.pruneLogs(ref, -1)).rejects.toThrow("projectLogRetentionDays");
    await expect(store.pruneLogs(ref, 366)).rejects.toThrow("projectLogRetentionDays");
  });
});
