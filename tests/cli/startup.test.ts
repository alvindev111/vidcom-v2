import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createBootstrapNonce, runStartupSequence, startVidcomFoundation, StartupError, type StartupStepName } from "@vidcom/cli";
import { AppDataBackupStore, initializeDatabase, RENDER_OWNER_MARKER, SqliteJobStore } from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, JobId, ResolvedPath } from "@vidcom/core";
import { createFixedClock, createSequentialIdPort } from "../support/deterministic";
import { dbOne, dbRun } from "../support/database";

const ordered = [
  "migration",
  "lease",
  "reconciliation",
  "job-recovery",
  "identity-backfill",
  "scheduler",
  "watcher",
  "listener",
] as const;

function steps(log: string[], fail?: StartupStepName) {
  const run = (name: StartupStepName) => async () => {
    log.push(name);
    if (name === fail) throw new Error(`${name} failed`);
  };
  return {
    migration: run("migration"),
    lease: run("lease"),
    reconciliation: run("reconciliation"),
    jobRecovery: run("job-recovery"),
    identityBackfill: run("identity-backfill"),
    scheduler: run("scheduler"),
    watcher: run("watcher"),
    listener: async () => { await run("listener")(); return "listener"; },
  };
}

describe("startup order", () => {
  it("creates a nonce accepted by the 32-byte bootstrap contract", () => {
    expect(Buffer.from(createBootstrapNonce(), "base64url")).toHaveLength(32);
  });
  it("runs every prerequisite before opening the listener", async () => {
    const log: string[] = [];
    await expect(runStartupSequence(steps(log))).resolves.toBe("listener");
    expect(log).toEqual(ordered);
  });

  it.each(ordered.slice(0, -1))("does not open listener when %s fails", async (failed) => {
    const log: string[] = [];
    await expect(runStartupSequence(steps(log, failed))).rejects.toMatchObject({
      name: "StartupError",
      step: failed,
    });
    expect(log).not.toContain("listener");
    expect(log).toEqual(ordered.slice(0, ordered.indexOf(failed) + 1));
  });

  it("maps listener bind failure to a named startup error", async () => {
    const log: string[] = [];
    await expect(runStartupSequence(steps(log, "listener"))).rejects.toEqual(
      expect.objectContaining<Partial<StartupError>>({ step: "listener" }),
    );
  });

  it("integrates migration and lease while preserving an unadopted candidate before listener", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    const hooks: string[] = [];
    try {
      const runtime = await startVidcomFoundation({
        appDataRoot: path.join(root, "app-data"),
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:1:boot",
        clock: createFixedClock("2026-08-01T00:00:00.000Z"),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() { hooks.push("jobs"); },
        async startScheduler() { hooks.push("scheduler"); },
        async startWatcher() { hooks.push("watcher"); },
        async openListener() { hooks.push("listener"); return { port: 4321 }; },
      });
      expect(hooks).toEqual(["jobs", "scheduler", "watcher", "listener"]);
      await expect(access(path.join(project, "vidcom.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await runtime.application.scanWorkspace()).toContainEqual({ kind: "candidate", slug: "project" });
      expect(runtime.listener).toEqual({ port: 4321 });
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims owned roots and reconciles the remove-to-clear crash window before opening the listener", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-render-root-"));
    const workspace = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    const jobId = "job_startup_cleanup" as JobId;
    const removedBeforeClearId = "job_removed_before_clear" as JobId;
    const unownedId = "job_unowned_cleanup" as JobId;
    const warnings: string[] = [];
    await mkdir(workspace, { recursive: true });
    const setupDatabase = await initializeDatabase(appData);
    dbRun(setupDatabase, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    "project_render_root", workspace, "project", "2026-08-03T22:00:00.000Z", "2026-08-03T22:00:00.000Z");
    const store = new SqliteJobStore(setupDatabase, createFixedClock("2026-08-03T22:00:00.000Z"));
    for (const id of [jobId, removedBeforeClearId, unownedId]) {
      await store.enqueue({
        id,
        projectId: "project_render_root" as ProjectId,
        type: "render",
        input: {},
        inputHash: `sha256:${"0".repeat(64)}` as ContentHash,
        idempotencyKey: null,
      });
      expect(await store.claim(id, "worker")).toBe(true);
      expect(await store.finish(id, { status: "succeeded", result: {}, cleanupPending: true })).toBe(true);
    }
    await setupDatabase.destroy();
    const renderRoot = path.join(appData, "render-roots", jobId);
    await mkdir(renderRoot, { recursive: true });
    await writeFile(path.join(renderRoot, RENDER_OWNER_MARKER), `${JSON.stringify({
      jobId,
      createdAt: "2026-08-03T22:00:00.000Z",
    })}\n`);
    const unownedRoot = path.join(appData, "render-roots", unownedId);
    await mkdir(unownedRoot, { recursive: true });
    await writeFile(path.join(unownedRoot, RENDER_OWNER_MARKER), "not-json\n");
    try {
      const runtime = await startVidcomFoundation({
        appDataRoot: appData,
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:render-root-recovery",
        clock: createFixedClock("2026-08-04T00:00:00.000Z"),
        ids: createSequentialIdPort(),
        logger: {
          warn(message) { warnings.push(message); },
          error() {},
        },
      }, {
        async recoverJobs() {},
        async startScheduler() {},
        async startWatcher() {},
        async openListener({ infrastructure }) {
          await expect(access(renderRoot)).rejects.toMatchObject({ code: "ENOENT" });
          expect((await infrastructure.jobs.get(jobId))?.cleanupPending).toBe(false);
          expect((await infrastructure.jobs.get(removedBeforeClearId))?.cleanupPending).toBe(false);
          expect((await infrastructure.jobs.get(unownedId))?.cleanupPending).toBe(true);
          await expect(access(unownedRoot)).resolves.toBeUndefined();
          expect(warnings).toContain("render root cleanup remains pending because ownership is invalid");
          return null;
        },
      });
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reclaims render roots when stale-job recovery fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-independent-recovery-"));
    const workspace = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    const renderRoot = path.join(appData, "render-roots", "job_independent");
    await mkdir(workspace, { recursive: true });
    await mkdir(renderRoot, { recursive: true });
    await writeFile(path.join(renderRoot, RENDER_OWNER_MARKER), `${JSON.stringify({
      jobId: "job_independent",
      createdAt: "2026-08-03T22:00:00.000Z",
    })}\n`);
    try {
      await expect(startVidcomFoundation({
        appDataRoot: appData,
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:independent-recovery",
        clock: createFixedClock("2026-08-04T00:00:00.000Z"),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() { throw new Error("injected stale recovery failure"); },
        async startScheduler() {},
        async startWatcher() {},
        async openListener() { return null; },
      })).rejects.toMatchObject({ name: "StartupError", step: "job-recovery" });
      await expect(access(renderRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles only journals owned by the workspace whose lease was acquired", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-scope-"));
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");
    const projectA = path.join(workspaceA, "alpha");
    const projectB = path.join(workspaceB, "beta");
    const appData = path.join(root, "app-data");
    const projectAId = "project_scope_a" as ProjectId;
    const projectBId = "project_scope_b" as ProjectId;
    const now = "2026-08-01T00:00:00.000Z";
    const digest = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    for (const [projectRoot, projectId, content] of [
      [projectA, projectAId, "alpha"],
      [projectB, projectBId, "before"],
    ] as const) {
      await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
      await writeFile(path.join(projectRoot, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`);
      await writeFile(path.join(projectRoot, "index.html"), content);
    }
    const setup = await initializeDatabase(appData);
    for (const [projectId, workspaceRoot, slug] of [
      [projectAId, workspaceA, "alpha"],
      [projectBId, workspaceB, "beta"],
    ] as const) {
      dbRun(setup, `INSERT INTO project_registry
        (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
      projectId, workspaceRoot, slug, now, now);
    }
    dbRun(setup, `INSERT INTO mutation_journal
      (project_id, kind, path, entity, from_hash, previous_content, previous_byte_size,
       to_hash, status, actor, created_at)
      VALUES (?, 'file', 'index.html', NULL, ?, ?, 6, ?, 'pending', 'agent', ?)`,
    projectBId, digest("before"), Buffer.from("before"), digest("after"), now);
    const journalId = dbOne<{ id: number }>(setup, "SELECT id FROM mutation_journal LIMIT 1")!.id;
    dbRun(setup, `INSERT INTO mutation_step
      (journal_id, ordinal, kind, path, entity, from_hash, to_hash, previous_content, previous_byte_size, status)
      VALUES (?, 0, 'write', 'index.html', NULL, ?, ?, ?, 6, 'pending')`,
    journalId, digest("before"), digest("after"), Buffer.from("before"));
    await setup.destroy();

    try {
      const runtime = await startVidcomFoundation({
        appDataRoot: appData,
        workspaceRoot: workspaceA as AbsolutePath,
        holderId: "test:scope-a",
        clock: createFixedClock(now),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() {},
        async startScheduler() {},
        async startWatcher() {},
        async openListener() { return null; },
      });
      expect(dbOne(runtime.infrastructure.database, "SELECT status FROM mutation_journal WHERE id = ?", journalId))
        .toEqual({ status: "pending" });
      expect(await readFile(path.join(projectB, "index.html"), "utf8")).toBe("before");
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes expired payloads and old orphan directories before opening the listener", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-backups-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    const projectId = "project_retention" as ProjectId;
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "vidcom.json"), `${JSON.stringify({ id: projectId })}\n`);
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    const setupDatabase = await initializeDatabase(appData);
    dbRun(setupDatabase, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
    projectId, workspace, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    const backups = new AppDataBackupStore(
      appData,
      setupDatabase,
      createFixedClock("2026-06-01T00:00:00.000Z"),
      { newId: () => "backup_expired" },
    );
    await backups.create(projectId, "old", [{
      path: "index.html" as RelPath,
      resolved: path.join(project, "index.html") as ResolvedPath,
    }]);
    await setupDatabase.destroy();
    const projectBackupRoot = path.join(appData, "backups", encodeURIComponent(projectId));
    const orphan = path.join(projectBackupRoot, "backup_orphan");
    await mkdir(orphan);
    await utimes(orphan, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
    let listenerObservedRetention = false;
    try {
      const runtime = await startVidcomFoundation({
        appDataRoot: appData,
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:retention",
        clock: createFixedClock("2026-08-02T00:00:00.000Z"),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() {},
        async startScheduler() {},
        async startWatcher() {},
        async openListener() {
          await expect(access(path.join(projectBackupRoot, "backup_expired", "payload"))).rejects.toThrow();
          await expect(access(orphan)).rejects.toThrow();
          listenerObservedRetention = true;
          return null;
        },
      });
      expect(listenerObservedRetention).toBe(true);
      await expect(runtime.infrastructure.backups.read("backup_expired"))
        .resolves.toMatchObject({ payloadPrunedAt: "2026-08-02T00:00:00.000Z" });
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unwinds scheduler and watcher when listener startup fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-unwind-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "vidcom.json"), '{"id":"project_startup_unwind"}\n');
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    const lifecycle: string[] = [];
    try {
      await expect(startVidcomFoundation({
        appDataRoot: path.join(root, "app-data"),
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:unwind",
        clock: createFixedClock("2026-08-01T00:00:00.000Z"),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() {},
        async startScheduler() { return { stop() { lifecycle.push("scheduler.stop"); } }; },
        async startWatcher() { return { close() { lifecycle.push("watcher.close"); } }; },
        async openListener() { throw new Error("bind failed"); },
      })).rejects.toMatchObject({ name: "StartupError", step: "listener" });
      expect(lifecycle).toEqual(["scheduler.stop", "watcher.close"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unwinds an acquired lease when abort arrives between startup phases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-abort-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    const controller = new AbortController();
    const reason = new Error("shutdown requested");
    const lifecycle: string[] = [];
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "vidcom.json"), '{"id":"project_startup_abort"}\n');
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    try {
      await expect(startVidcomFoundation({
        appDataRoot: appData,
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:abort",
        clock: createFixedClock("2026-08-01T00:00:00.000Z"),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() {
          lifecycle.push("jobs");
          controller.abort(reason);
        },
        async startScheduler() { lifecycle.push("scheduler"); },
        async startWatcher() { lifecycle.push("watcher"); },
        async openListener() { lifecycle.push("listener"); return null; },
      }, { signal: controller.signal })).rejects.toBe(reason);
      expect(lifecycle).toEqual(["jobs"]);
      const database = await initializeDatabase(appData);
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await database.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops listener before background work on a successful shutdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-stop-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "vidcom.json"), '{"id":"project_startup_stop"}\n');
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    const lifecycle: string[] = [];
    try {
      const runtime = await startVidcomFoundation({
        appDataRoot: path.join(root, "app-data"),
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:stop",
        clock: createFixedClock("2026-08-01T00:00:00.000Z"),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() {},
        async startScheduler() { return { stop() { lifecycle.push("scheduler.stop"); } }; },
        async startWatcher() { return { close() { lifecycle.push("watcher.close"); } }; },
        async openListener() { return { close() { lifecycle.push("listener.close"); } }; },
      });
      await runtime.stop();
      expect(lifecycle).toEqual(["listener.close", "scheduler.stop", "watcher.close"]);
      const database = await initializeDatabase(path.join(root, "app-data"));
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await database.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["listener", "scheduler", "watcher", "lease", "database"] as const)(
    "attempts the complete idempotent unwind when %s cleanup fails",
    async (failure) => {
      const root = await mkdtemp(path.join(tmpdir(), `vidcom-startup-cleanup-${failure}-`));
      const workspace = path.join(root, "workspace");
      const project = path.join(workspace, "project");
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, "hyperframes.json"), "{}\n");
      await writeFile(path.join(project, "vidcom.json"), `{\"id\":\"project_cleanup_${failure}\"}\n`);
      await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
      const lifecycle: string[] = [];
      try {
        const runtime = await startVidcomFoundation({
          appDataRoot: path.join(root, "app-data"),
          workspaceRoot: workspace as AbsolutePath,
          holderId: `test:cleanup:${failure}`,
          clock: createFixedClock("2026-08-01T00:00:00.000Z"),
          ids: createSequentialIdPort(),
        }, {
          async recoverJobs() {},
          async startScheduler() {
            return { stop() { lifecycle.push("scheduler.stop"); if (failure === "scheduler") throw new Error(failure); } };
          },
          async startWatcher() {
            return { close() { lifecycle.push("watcher.close"); if (failure === "watcher") throw new Error(failure); } };
          },
          async openListener() {
            return { close() { lifecycle.push("listener.close"); if (failure === "listener") throw new Error(failure); } };
          },
        });
        const release = runtime.infrastructure.lease.release.bind(runtime.infrastructure.lease);
        runtime.infrastructure.lease.release = async (id) => {
          lifecycle.push("lease.release");
          await release(id);
          if (failure === "lease") throw new Error(failure);
        };
        const destroy = runtime.infrastructure.database.destroy.bind(runtime.infrastructure.database);
        runtime.infrastructure.database.destroy = async () => {
          lifecycle.push("database.destroy");
          await destroy();
          if (failure === "database") throw new Error(failure);
        };

        const first = runtime.stop();
        const second = runtime.stop();
        expect(second).toBe(first);
        await expect(first).rejects.toMatchObject({
          name: "AggregateError",
          errors: [expect.objectContaining({ message: failure })],
        });
        await expect(second).rejects.toBeInstanceOf(AggregateError);
        expect(lifecycle).toEqual([
          "listener.close",
          "scheduler.stop",
          "watcher.close",
          "lease.release",
          "database.destroy",
        ]);
        const database = await initializeDatabase(path.join(root, "app-data"));
        expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease")).toEqual({ count: 0 });
        await database.destroy();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
