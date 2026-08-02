import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  reconcileCompositeMutations,
  reconcileCompositeMutation,
  resolveOrphanedMutation,
  type AbsolutePath,
  type ClockPort,
  type ProjectRef,
  type LeasePort,
  type GrantBinding,
  type PendingMutationContext,
  type StepIntent,
} from "@vidcom/core";
import { CompositionHf, initializeDatabase, MutationJournal, WorkspaceFs } from "@vidcom/adapter";

import { dbOne, dbRun } from "../support/database";

let root: string;
let workspaceRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;

const now = "2026-08-02T00:00:00.000Z";
const clock: ClockPort = { now: () => new Date(now) };
const hash = (content: string): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-composite-recovery-"));
  workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  database = await initializeDatabase(path.join(root, "app-data"));
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

function register(projectId: ProjectId, slug: string): void {
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, workspaceRoot, slug, now, now);
}

function step(pathname: string, previous: string, next: string): StepIntent {
  return {
    ordinal: 0,
    kind: "write",
    path: pathname as RelPath,
    entity: null,
    fromHash: hash(previous),
    toHash: hash(next),
    previousContent: previous,
  };
}

async function liveProject(slug: string, content: string) {
  const projectId = `project_${slug}` as ProjectId;
  register(projectId, slug);
  const projectRoot = path.join(workspaceRoot, slug);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
  await writeFile(path.join(projectRoot, "index.html"), content);
  const ref: ProjectRef = {
    id: projectId,
    slug,
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  return { projectId, projectRoot, ref };
}

describe("composite recovery persistence", () => {
  it("isolates an orphaned project while rolling a healthy project forward", async () => {
    const missingId = "project_missing_recovery" as ProjectId;
    const healthyId = "project_healthy_recovery" as ProjectId;
    register(missingId, "missing");
    register(healthyId, "healthy");
    const healthyRoot = path.join(workspaceRoot, "healthy");
    await mkdir(healthyRoot, { recursive: true });
    await writeFile(path.join(healthyRoot, "vidcom.json"), JSON.stringify({ id: healthyId }));
    await writeFile(path.join(healthyRoot, "index.html"), "healthy-new");

    const journal = new MutationJournal(database, clock);
    const missingJournal = await journal.beginComposite(
      { projectId: missingId, actor: "agent" },
      [step("index.html", "missing-old", "missing-new")],
      { toolAudit: null },
    );
    const healthyJournal = await journal.beginComposite(
      { projectId: healthyId, actor: "agent" },
      [step("index.html", "healthy-old", "healthy-new")],
      { toolAudit: null },
    );
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);

    const report = await reconcileCompositeMutations({
      workspace,
      journal,
      async resolveProjectRef(projectId): Promise<ProjectRef | null> {
        return projectId === healthyId
          ? {
              id: healthyId,
              slug: "healthy",
              root: healthyRoot as AbsolutePath,
              entry: "index.html" as RelPath,
            }
          : null;
      },
    });

    expect(report).toEqual({
      pending: [],
      recovered: [healthyJournal],
      rolledBack: [],
      orphaned: [missingJournal],
    });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", missingJournal))
      .toEqual({ status: "orphaned" });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", healthyJournal))
      .toEqual({ status: "committed" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision WHERE project_id = ?", healthyId))
      .toEqual({ count: 1 });
  });

  it("restores an orphan in reverse order and finalizes it with cli-external audit", async () => {
    const projectId = "project_restore_orphan" as ProjectId;
    register(projectId, "restore");
    const projectRoot = path.join(workspaceRoot, "restore");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), "tampered");
    const ref: ProjectRef = {
      id: projectId,
      slug: "restore",
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("index.html", "before", "intended")],
      { toolAudit: null },
    );
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired);
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const lease: LeasePort = {
      async acquire() { throw new Error("unused"); },
      async renew() { return true; },
      async release() {},
      async assertHeld() { return true; },
    };

    const result = await resolveOrphanedMutation({
      workspace,
      journal,
      composition: new CompositionHf(),
      lease,
      leaseId: "lease-1",
      async resolveProjectRef() { return ref; },
    }, id, "restore-previous", "cli-external");

    expect(result).toEqual({ ok: true, value: null });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("before");
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "rolled_back" });
    expect(dbOne(database, `SELECT action, actor FROM audit_entry
      WHERE action = 'recovery.restore_previous'`)).toEqual({
      action: "recovery.restore_previous",
      actor: "cli-external",
    });
  });

  it("accepts a validated current orphan as one reconciliation revision", async () => {
    const projectId = "project_accept_orphan" as ProjectId;
    register(projectId, "accept");
    const projectRoot = path.join(workspaceRoot, "accept");
    const current = '<main data-composition-id="main" data-duration="1"></main>';
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), current);
    const ref: ProjectRef = {
      id: projectId,
      slug: "accept",
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("index.html", "before", "intended")],
      { toolAudit: null },
    );
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired);
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const lease: LeasePort = {
      async acquire() { throw new Error("unused"); },
      async renew() { return true; },
      async release() {},
      async assertHeld() { return true; },
    };

    const result = await resolveOrphanedMutation({
      workspace,
      journal,
      composition: new CompositionHf(),
      lease,
      leaseId: "lease-1",
      async resolveProjectRef() { return ref; },
    }, id, "accept-current", "cli-external");

    expect(result).toMatchObject({ ok: true, value: { projectRevision: 1 } });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "recovered" });
    expect(dbOne(database, "SELECT to_hash AS toHash FROM revision_step WHERE revision_id = 1"))
      .toEqual({ toHash: hash(current) });
    expect(dbOne(database, `SELECT action, actor, revision_id AS revisionId FROM audit_entry
      WHERE action = 'recovery.accept_current'`)).toEqual({
      action: "recovery.accept_current",
      actor: "cli-external",
      revisionId: 1,
    });
  });

  it("resolves only the selected orphan and keeps the project gate closed for another", async () => {
    const projectId = "project_two_orphans" as ProjectId;
    register(projectId, "two-orphans");
    const projectRoot = path.join(workspaceRoot, "two-orphans");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), "tampered-a");
    await writeFile(path.join(projectRoot, "other.html"), "tampered-b");
    const ref: ProjectRef = {
      id: projectId,
      slug: "two-orphans",
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const journal = new MutationJournal(database, clock);
    const first = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("index.html", "before-a", "intended-a")],
      { toolAudit: null },
    );
    await journal.orphanComposite(first, ErrorCode.RecoveryRequired);
    const second = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("other.html", "before-b", "intended-b")],
      { toolAudit: null },
    );
    await journal.orphanComposite(second, ErrorCode.RecoveryRequired);
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const lease: LeasePort = {
      async acquire() { throw new Error("unused"); },
      async renew() { return true; },
      async release() {},
      async assertHeld() { return true; },
    };

    await expect(resolveOrphanedMutation({
      workspace,
      journal,
      composition: new CompositionHf(),
      lease,
      leaseId: "lease-1",
      async resolveProjectRef() { return ref; },
    }, first, "restore-previous", "cli-external")).resolves.toEqual({ ok: true, value: null });

    await expect(journal.readProjectRecoveryStatus(projectId)).resolves.toEqual({
      writeStatus: "recovery_required",
      unresolved: [{ journalId: second, status: "orphaned" }],
    });
    await expect(journal.assertProjectWritable(projectId)).rejects.toMatchObject({
      code: ErrorCode.RecoveryRequired,
    });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("before-a");
    expect(await readFile(path.join(projectRoot, "other.html"), "utf8")).toBe("tampered-b");
  });

  it("keeps T2a pending on injected failure and aborts deterministically after storage recovers", async () => {
    const { projectId, ref } = await liveProject("t2a", "before");
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("index.html", "before", "after")],
      { toolAudit: null },
    );
    const dependencies = {
      workspace: new WorkspaceFs(workspaceRoot as AbsolutePath),
      journal,
      async resolveProjectRef() { return ref; },
    };
    dbRun(database, `CREATE TRIGGER fail_recovery_t2a BEFORE UPDATE OF status ON mutation_journal
      WHEN NEW.status = 'aborted' BEGIN SELECT RAISE(ABORT, 'injected T2a'); END`);
    await expect(reconcileCompositeMutation(dependencies, id)).resolves.toMatchObject({ ok: false });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "pending" });
    dbRun(database, "DROP TRIGGER fail_recovery_t2a");
    await expect(reconcileCompositeMutation(dependencies, id)).resolves.toEqual({
      ok: true,
      value: { terminal: "aborted" },
    });
    await expect(reconcileCompositeMutations(dependencies)).resolves.toEqual({
      pending: [], recovered: [], rolledBack: [], orphaned: [],
    });
  });

  it("retries T2b with the exact grant and audit without rewriting landed bytes", async () => {
    const current = '<main data-composition-id="main">recovered</main>';
    const { projectId, projectRoot, ref } = await liveProject("t2b", current);
    const binding: GrantBinding = {
      tool: "delete_scene",
      projectId,
      target: "scene-1",
      expectedRevision: 0,
      planDigest: hash("plan"),
      targetHashes: { ["index.html" as RelPath]: hash("before") },
    };
    dbRun(database, `INSERT INTO approval_grant
      (id, project_id, tool, target, expected_revision, plan_digest, target_hashes,
       summary, status, created_at, expires_at)
      VALUES ('grant-recovery', ?, ?, ?, 0, ?, ?, 'Recover', 'issued', ?, ?)`,
    projectId, binding.tool, binding.target, binding.planDigest,
    canonicalizeJson(binding.targetHashes), now, "2026-08-02T00:05:00.000Z");
    const context: PendingMutationContext = {
      toolAudit: {
        schemaVersion: 1,
        invocationId: "invocation-recovery",
        tool: "delete_scene",
        level: "destructive",
        projectId,
        era: "modern",
        protocolVersion: "2026-07-28",
        detail: { sceneId: "scene-1" },
        credentialId: "credential-recovery",
        invokedAt: now,
      },
    };
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("index.html", "before", current)],
      context,
      { kind: "reserve", grantId: "grant-recovery", binding },
    );
    const dependencies = {
      workspace: new WorkspaceFs(workspaceRoot as AbsolutePath),
      journal,
      async resolveProjectRef() { return ref; },
    };
    const modifiedBefore = (await stat(path.join(projectRoot, "index.html"))).mtimeMs;
    dbRun(database, `CREATE TRIGGER fail_recovery_t2b BEFORE INSERT ON revision
      BEGIN SELECT RAISE(ABORT, 'injected T2b'); END`);
    await expect(reconcileCompositeMutation(dependencies, id)).resolves.toMatchObject({ ok: false });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-recovery'"))
      .toEqual({ status: "reserved" });
    dbRun(database, "DROP TRIGGER fail_recovery_t2b");
    await expect(reconcileCompositeMutation(dependencies, id)).resolves.toMatchObject({
      ok: true,
      value: { terminal: "committed", envelope: { projectRevision: 1 } },
    });
    expect((await stat(path.join(projectRoot, "index.html"))).mtimeMs).toBe(modifiedBefore);
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-recovery'"))
      .toEqual({ status: "consumed" });
    const audit = dbOne<{ detail: string }>(database,
      "SELECT detail FROM audit_entry WHERE action = 'tool:delete_scene'");
    expect(JSON.parse(audit?.detail ?? "null")).toMatchObject({
      recovered: true,
      invocationId: "invocation-recovery",
      credentialId: "credential-recovery",
    });
    await expect(reconcileCompositeMutations(dependencies)).resolves.toEqual({
      pending: [], recovered: [], rolledBack: [], orphaned: [],
    });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry WHERE action = 'tool:delete_scene'"))
      .toEqual({ count: 1 });
  });

  it("keeps T2c pending on injection and orphans a rollback that cannot be proven", async () => {
    const { projectId, projectRoot, ref } = await liveProject("t2c", "tampered-a");
    await writeFile(path.join(projectRoot, "other.html"), "before-b");
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [
        { ...step("index.html", "before-a", "tampered-a"), previousContent: null },
        { ...step("other.html", "before-b", "after-b"), ordinal: 1 },
      ],
      { toolAudit: null },
    );
    const dependencies = {
      workspace: new WorkspaceFs(workspaceRoot as AbsolutePath),
      journal,
      async resolveProjectRef() { return ref; },
    };
    dbRun(database, `CREATE TRIGGER fail_recovery_t2c BEFORE UPDATE OF status ON mutation_journal
      WHEN NEW.status = 'orphaned' BEGIN SELECT RAISE(ABORT, 'injected T2c'); END`);
    await expect(reconcileCompositeMutation(dependencies, id)).resolves.toMatchObject({ ok: false });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "pending" });
    dbRun(database, "DROP TRIGGER fail_recovery_t2c");
    await expect(reconcileCompositeMutation(dependencies, id)).resolves.toEqual({
      ok: true,
      value: { terminal: "orphaned" },
    });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "orphaned" });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("tampered-a");
    expect(await readFile(path.join(projectRoot, "other.html"), "utf8")).toBe("before-b");
  });

  it("keeps accept-current orphaned when full source validation fails", async () => {
    const { projectId, ref } = await liveProject("accept_invalid", "<p>no composition host</p>");
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("index.html", "before", "intended")],
      { toolAudit: null },
    );
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired);
    const lease: LeasePort = {
      async acquire() { throw new Error("unused"); },
      async renew() { return true; },
      async release() {},
      async assertHeld() { return true; },
    };
    await expect(resolveOrphanedMutation({
      workspace: new WorkspaceFs(workspaceRoot as AbsolutePath),
      journal,
      composition: new CompositionHf(),
      lease,
      leaseId: "lease-1",
      async resolveProjectRef() { return ref; },
    }, id, "accept-current", "cli-external")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.SdkRejected },
    });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "orphaned" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
  });

  it("keeps the orphan gate after a crash between restore verification and terminal commit", async () => {
    const { projectId, projectRoot, ref } = await liveProject("restore_crash", "tampered");
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [step("index.html", "before", "intended")],
      { toolAudit: null },
    );
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired);
    const lease: LeasePort = {
      async acquire() { throw new Error("unused"); },
      async renew() { return true; },
      async release() {},
      async assertHeld() { return true; },
    };
    const dependencies = {
      workspace: new WorkspaceFs(workspaceRoot as AbsolutePath),
      journal,
      composition: new CompositionHf(),
      lease,
      leaseId: "lease-1",
      async resolveProjectRef() { return ref; },
    };
    dbRun(database, `CREATE TRIGGER fail_restore_terminal BEFORE UPDATE OF status ON mutation_journal
      WHEN OLD.status = 'orphaned' AND NEW.status = 'rolled_back'
      BEGIN SELECT RAISE(ABORT, 'injected restore terminal failure'); END`);
    await expect(resolveOrphanedMutation(
      dependencies,
      id,
      "restore-previous",
      "cli-external",
    )).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.RecoveryRequired } });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("before");
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "orphaned" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry WHERE action = 'recovery.restore_previous'"))
      .toEqual({ count: 0 });
    dbRun(database, "DROP TRIGGER fail_restore_terminal");
    await expect(resolveOrphanedMutation(
      dependencies,
      id,
      "restore-previous",
      "cli-external",
    )).resolves.toEqual({ ok: true, value: null });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "rolled_back" });
  });
});
