import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  canonicalizeJson,
  type ClockPort,
  type GrantBinding,
  type PendingMutationContext,
  type StepResult,
  type StepIntent,
} from "@vidcom/core";
import {
  initializeDatabase,
  JournalTransactionError,
  LargePreviousContentStore,
  MutationJournal,
  type PreviousContentStore,
} from "@vidcom/adapter";

import { dbAll, dbOne, dbRun } from "../support/database";

let root: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
const now = "2026-08-02T00:00:00.000Z";
const projectId = "project_composite" as ProjectId;
const hash = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;
const clock: ClockPort = { now: () => new Date(now) };
const authority = { leaseId: "lease-composite" };

const binding: GrantBinding = {
  tool: "delete_scene",
  projectId,
  target: "scene-1",
  expectedRevision: 0,
  planDigest: hash("a"),
  targetHashes: { ["index.html" as RelPath]: hash("1") },
};

const context: PendingMutationContext = {
  toolAudit: {
    schemaVersion: 1,
    invocationId: "invocation-1",
    tool: "delete_scene",
    level: "destructive",
    projectId,
    era: "modern",
    protocolVersion: "2026-07-28",
    detail: { sceneId: "scene-1" },
    credentialId: "credential-1",
    invokedAt: now,
    revisionBefore: 0,
  },
};

const reservedContext: PendingMutationContext = {
  toolAudit: {
    ...context.toolAudit!,
    detail: { ...context.toolAudit!.detail, grantId: "grant-1" },
  },
};

const steps: StepIntent[] = [
  {
    ordinal: 0,
    kind: "write",
    path: "index.html" as RelPath,
    entity: null,
    fromHash: hash("1"),
    toHash: hash("2"),
    previousContent: "entry-before",
  },
  {
    ordinal: 1,
    kind: "delete",
    path: "compositions/scene-1.html" as RelPath,
    entity: null,
    fromHash: hash("3"),
    toHash: null,
    previousContent: "scene-before",
  },
];

function committedResult(eventProjectId: ProjectId = projectId) {
  const committedSteps: StepResult[] = steps.map((step) => ({ ...step, status: "written" }));
  return {
    projectId,
    actor: "agent" as const,
    steps: committedSteps,
    diagnostics: [],
    event: { type: "project.changed" as const, projectId: eventProjectId, payload: { source: "composite" } },
  };
}

async function beginReserved(journal: MutationJournal) {
  return journal.beginComposite(
    { projectId, actor: "agent" },
    steps,
    context,
    authority,
    { kind: "reserve", grantId: "grant-1", binding },
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-composite-journal-"));
  database = await initializeDatabase(root);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, "/workspace", "project", now, now);
  dbRun(database, `INSERT INTO workspace_lease
    (workspace_root, lease_id, holder_id, acquired_at, expires_at)
    VALUES ('/workspace', ?, 'test', ?, '2026-08-02T01:00:00.000Z')`, authority.leaseId, now);
  dbRun(database, `INSERT INTO approval_grant
    (id, project_id, tool, target, expected_revision, plan_digest, target_hashes,
     summary, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`,
  "grant-1", projectId, binding.tool, binding.target, binding.expectedRevision,
  binding.planDigest, canonicalizeJson(binding.targetHashes), "Delete scene", now, "2026-08-02T00:05:00.000Z");
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("MutationJournal composite transaction primitives", () => {
  it("persists T1 parent, ordered steps, canonical context and grant reserve atomically", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      steps,
      context,
      authority,
      { kind: "reserve", grantId: "grant-1", binding },
    );

    expect(dbOne(database, `SELECT kind, path, grant_id AS grantId, tool_audit_json AS audit
      FROM mutation_journal WHERE id = ?`, id)).toEqual({
      kind: "composite",
      path: null,
      grantId: "grant-1",
      audit: canonicalizeJson(reservedContext.toolAudit),
    });
    expect(dbAll(database, `SELECT ordinal, kind, path, from_hash AS fromHash, to_hash AS toHash,
      previous_byte_size AS previousByteSize FROM mutation_step WHERE journal_id = ? ORDER BY ordinal`, id))
      .toEqual([
        { ordinal: 0, kind: "write", path: "index.html", fromHash: hash("1"), toHash: hash("2"), previousByteSize: 12 },
        { ordinal: 1, kind: "delete", path: "compositions/scene-1.html", fromHash: hash("3"), toHash: null, previousByteSize: 12 },
      ]);
    expect(dbOne(database, "SELECT status, reserved_at AS reservedAt FROM approval_grant WHERE id = 'grant-1'"))
      .toEqual({ status: "reserved", reservedAt: now });

    dbRun(database, `INSERT INTO backup_manifest
      (id, project_id, revision_id, reason, entries, manifest_hash, created_at, payload_pruned_at)
      VALUES ('backup-1', ?, NULL, 'tool:delete_scene', '[]', ?, ?, NULL)`, projectId, hash("b"), now);
    await journal.attachBackup(id, "backup-1");
    const linked = dbOne<{ backupId: string; audit: string }>(database,
      "SELECT backup_id AS backupId, tool_audit_json AS audit FROM mutation_journal WHERE id = ?", id);
    expect(linked?.backupId).toBe("backup-1");
    expect(JSON.parse(linked?.audit ?? "null")).toMatchObject({ detail: { backupId: "backup-1", sceneId: "scene-1" } });

    const result = committedResult();
    const envelope = await journal.commitComposite(id, result, { kind: "consume", grantId: "grant-1" });
    expect(envelope).toMatchObject({ projectRevision: 1, entityRevision: null, fileHashes: { "index.html": hash("2") } });
    expect(dbOne(database, "SELECT kind, path, content_hash AS contentHash FROM revision WHERE id = 1"))
      .toMatchObject({ kind: "composite", path: null, contentHash: expect.stringMatching(/^sha256:/) });
    expect(dbAll(database, "SELECT ordinal, kind, backup_id AS backupId FROM revision_step ORDER BY ordinal"))
      .toEqual([
        { ordinal: 0, kind: "write", backupId: "backup-1" },
        { ordinal: 1, kind: "delete", backupId: "backup-1" },
      ]);
    expect(dbAll(database, `SELECT action, revision_id AS revisionId, protocol_version AS protocolVersion,
      outcome FROM audit_entry ORDER BY id`))
      .toEqual([
        { action: "composite.write", revisionId: 1, protocolVersion: null, outcome: "ok" },
        { action: "tool:delete_scene", revisionId: 1, protocolVersion: "2026-07-28", outcome: "ok" },
      ]);
    const toolDetail = dbOne<{ detail: string }>(database,
      "SELECT detail FROM audit_entry WHERE action = 'tool:delete_scene'");
    expect(JSON.parse(toolDetail?.detail ?? "null")).toMatchObject({
      backupId: "backup-1",
      grantId: "grant-1",
      credentialId: "credential-1",
      invocationId: "invocation-1",
    });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "committed" });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-1'")).toEqual({ status: "consumed" });
    expect(dbOne(database, "SELECT revision_id AS revisionId FROM backup_manifest WHERE id = 'backup-1'"))
      .toEqual({ revisionId: 1 });
    expect(dbOne(database, "SELECT type, payload FROM event_outbox")).toEqual({
      type: "project.changed",
      payload: canonicalizeJson({ source: "composite" }),
    });
    await expect(journal.commitComposite(id, result, { kind: "consume", grantId: "grant-1" }))
      .rejects.toThrow("pending mutation journal does not match composite result");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 2 });
    await expect(journal.isJournalOwned("invocation-1")).resolves.toBe(true);
  });

  it("deduplicates large rollback bytes outside SQLite and compacts only unreferenced objects", async () => {
    const largeContent = new LargePreviousContentStore(root);
    const journal = new MutationJournal(database, clock, largeContent);
    const previousContent = new Uint8Array(2 * 1024 * 1024).fill(97);
    const largeStep: StepIntent = {
      ordinal: 0,
      kind: "write",
      path: "narration/large.wav" as RelPath,
      entity: null,
      fromHash: hash("4"),
      toHash: hash("5"),
      previousContent,
    };
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      [largeStep],
      { toolAudit: null },
      authority,
    );
    const hydrated = await journal.readSteps(id);
    expect(hydrated).toMatchObject([{ ...largeStep, previousContent: expect.any(Uint8Array) }]);
    expect(Buffer.from(hydrated[0]!.previousContent as Uint8Array).equals(Buffer.from(previousContent))).toBe(true);
    await journal.commitComposite(id, {
      projectId,
      actor: "agent",
      steps: [{ ...largeStep, status: "written" }],
      diagnostics: [],
      event: { type: "project.changed", projectId, payload: { source: "large-content-test" } },
    });

    const references = dbAll<{ hash: string }>(database, `
      SELECT previous_object_hash AS hash FROM mutation_journal WHERE id = ?
      UNION ALL SELECT previous_object_hash AS hash FROM mutation_step WHERE journal_id = ?
      UNION ALL SELECT previous_object_hash AS hash FROM revision_step WHERE revision_id = 1
      UNION ALL SELECT previous_object_hash AS hash FROM revision_blob WHERE revision_id = 1
    `, id, id);
    expect(references).toHaveLength(4);
    expect(new Set(references.map(({ hash: objectHash }) => objectHash)).size).toBe(1);
    expect(references[0]?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(dbOne(database, `SELECT
      COALESCE(length(mutation_journal.previous_content), 0)
        + COALESCE(length(mutation_step.previous_content), 0)
        + COALESCE(length(revision_step.previous_content), 0)
        + COALESCE(length(revision_blob.previous_content), 0) AS inlineBytes
      FROM mutation_journal
      JOIN mutation_step ON mutation_step.journal_id = mutation_journal.id
      JOIN revision_step ON revision_step.revision_id = 1
      JOIN revision_blob ON revision_blob.revision_id = 1
      WHERE mutation_journal.id = ?`, id)).toEqual({ inlineBytes: 0 });
    const page = dbOne<{ pageCount: number; pageSize: number }>(database,
      "SELECT (SELECT page_count FROM pragma_page_count) AS pageCount, (SELECT page_size FROM pragma_page_size) AS pageSize");
    expect((page?.pageCount ?? 0) * (page?.pageSize ?? 0)).toBeLessThan(previousContent.byteLength);

    const liveReferences = await journal.listPreviousObjectHashes();
    await expect(largeContent.cleanupUnreferenced(liveReferences, new Date("2100-01-01"))).resolves.toBe(0);
    dbRun(database, "UPDATE mutation_journal SET previous_object_hash = NULL WHERE id = ?", id);
    dbRun(database, "UPDATE mutation_step SET previous_object_hash = NULL WHERE journal_id = ?", id);
    dbRun(database, "UPDATE revision_step SET previous_object_hash = NULL WHERE revision_id = 1");
    dbRun(database, "UPDATE revision_blob SET previous_object_hash = NULL WHERE revision_id = 1");
    await expect(largeContent.cleanupUnreferenced(
      await journal.listPreviousObjectHashes(),
      new Date("2100-01-01"),
    )).resolves.toBe(1);
    await expect(largeContent.read(references[0]!.hash as ContentHash)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before T1 on initial object ENOSPC but does not rewrite an object after T1", async () => {
    const previousContent = new Uint8Array(128 * 1024).fill(98);
    let persisted = false;
    let rejectNewWrites = true;
    const objectHash = hash("6");
    const store: PreviousContentStore = {
      async put() {
        if (!persisted && rejectNewWrites) {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        persisted = true;
        return objectHash;
      },
      async read() { return previousContent; },
    };
    const journal = new MutationJournal(database, clock, store);
    const largeStep: StepIntent = {
      ordinal: 0,
      kind: "delete",
      path: "narration/large.wav" as RelPath,
      entity: null,
      fromHash: hash("7"),
      toHash: null,
      previousContent,
    };
    await expect(journal.beginComposite(
      { projectId, actor: "agent" }, [largeStep], { toolAudit: null }, authority,
    )).rejects.toMatchObject({ code: "ENOSPC" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_journal")).toEqual({ count: 0 });

    rejectNewWrites = false;
    const id = await journal.beginComposite(
      { projectId, actor: "agent" }, [largeStep], { toolAudit: null }, authority,
    );
    rejectNewWrites = true;
    await expect(journal.commitComposite(id, {
      projectId,
      actor: "agent",
      steps: [{ ...largeStep, status: "written" }],
      diagnostics: [],
      event: { type: "project.changed", projectId, payload: { source: "large-content-test" } },
    })).resolves.toMatchObject({ projectRevision: 1 });
  });

  it("rolls back every T1 row when the grant binding differs", async () => {
    const journal = new MutationJournal(database, clock);
    await expect(journal.beginComposite(
      { projectId, actor: "agent" },
      steps,
      context,
      authority,
      { kind: "reserve", grantId: "grant-1", binding: { ...binding, target: "scene-2" } },
    )).rejects.toMatchObject({ name: "JournalTransactionError", code: ErrorCode.ApprovalInvalid } satisfies Partial<JournalTransactionError>);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_journal")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_step")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-1'")).toEqual({ status: "issued" });
  });

  it("aborts T2a atomically, releases the grant and returns cleared audit context", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      steps,
      context,
      authority,
      { kind: "reserve", grantId: "grant-1", binding },
    );
    await expect(journal.abortComposite(id, ErrorCode.WriteConflict, {
      kind: "release",
      grantId: "grant-1",
    })).resolves.toEqual(reservedContext);
    expect(dbOne(database, "SELECT status, grant_id AS grantId, tool_audit_json AS audit FROM mutation_journal WHERE id = ?", id))
      .toEqual({ status: "aborted", grantId: null, audit: null });
    expect(dbOne(database, "SELECT status, reserved_at AS reservedAt FROM approval_grant WHERE id = 'grant-1'"))
      .toEqual({ status: "issued", reservedAt: null });
    await expect(journal.abortComposite(id, ErrorCode.WriteConflict, {
      kind: "release",
      grantId: "grant-1",
    })).resolves.toBeNull();
    await expect(journal.isJournalOwned("invocation-1")).resolves.toBe(false);
    await expect(journal.readProjectRecoveryStatus(projectId)).resolves.toEqual({
      writeStatus: "ready",
      unresolved: [],
    });
  });

  it("settles a verified mixed recovery as rolled_back without duplicating context", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await beginReserved(journal);
    await expect(journal.rollbackComposite(id, ErrorCode.StorageUnavailable, {
      kind: "release",
      grantId: "grant-1",
    })).resolves.toEqual(reservedContext);
    expect(dbOne(database, `SELECT status, grant_id AS grantId, tool_audit_json AS audit
      FROM mutation_journal WHERE id = ?`, id)).toEqual({ status: "rolled_back", grantId: null, audit: null });
    expect(dbAll(database, "SELECT status FROM mutation_step WHERE journal_id = ? ORDER BY ordinal", id))
      .toEqual([{ status: "rolled_back" }, { status: "rolled_back" }]);
    expect(dbOne(database, "SELECT status, reserved_at AS reservedAt FROM approval_grant WHERE id = 'grant-1'"))
      .toEqual({ status: "issued", reservedAt: null });
    await expect(journal.rollbackComposite(id, ErrorCode.StorageUnavailable, {
      kind: "release",
      grantId: "grant-1",
    })).resolves.toBeNull();
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
  });

  it("annotates an all-landed recovery audit and consumes its exact grant once", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await beginReserved(journal);
    const result = { ...committedResult(), recovered: true };
    await journal.commitComposite(id, result, { kind: "consume", grantId: "grant-1" });
    const audit = dbOne<{ detail: string }>(database,
      "SELECT detail FROM audit_entry WHERE action = 'tool:delete_scene'");
    expect(JSON.parse(audit?.detail ?? "null")).toMatchObject({
      recovered: true,
      invocationId: "invocation-1",
      credentialId: "credential-1",
    });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-1'"))
      .toEqual({ status: "consumed" });
    await expect(journal.commitComposite(id, result, { kind: "consume", grantId: "grant-1" }))
      .rejects.toThrow("pending mutation journal does not match composite result");
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry WHERE action = 'tool:delete_scene'"))
      .toEqual({ count: 1 });
    await expect(journal.isJournalOwned("invocation-1")).resolves.toBe(true);
  });

  it("orphans T2c with an error audit and invalidates the exact reserved grant", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" },
      steps,
      context,
      authority,
      { kind: "reserve", grantId: "grant-1", binding },
    );
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired, {
      kind: "invalidate",
      grantId: "grant-1",
      reason: "rollback_failed",
    });
    expect(dbOne(database, "SELECT status, grant_id AS grantId FROM mutation_journal WHERE id = ?", id))
      .toEqual({ status: "orphaned", grantId: "grant-1" });
    expect(dbOne(database, `SELECT status, invalidated_reason AS reason
      FROM approval_grant WHERE id = 'grant-1'`)).toEqual({ status: "invalidated", reason: "rollback_failed" });
    expect(dbOne(database, `SELECT action, outcome, error_code AS errorCode, protocol_version AS protocolVersion
      FROM audit_entry`)).toEqual({
      action: "tool:delete_scene",
      outcome: "error",
      errorCode: ErrorCode.RecoveryRequired,
      protocolVersion: "2026-07-28",
    });
    const orphanDetail = dbOne<{ detail: string }>(database, "SELECT detail FROM audit_entry");
    expect(JSON.parse(orphanDetail?.detail ?? "null")).toMatchObject({
      grantId: "grant-1",
      credentialId: "credential-1",
      invocationId: "invocation-1",
    });
    await expect(journal.orphanComposite(id, ErrorCode.RecoveryRequired, {
      kind: "invalidate",
      grantId: "grant-1",
      reason: "rollback_failed",
    })).resolves.toBeUndefined();
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 1 });
    await expect(journal.isJournalOwned("invocation-1")).resolves.toBe(true);
    await expect(journal.readPendingComposite(id)).resolves.toMatchObject({
      id,
      status: "orphaned",
      grantId: "grant-1",
      steps: [{ ordinal: 0, kind: "write" }, { ordinal: 1, kind: "delete" }],
      context,
    });
    await expect(journal.listPendingComposites("/workspace")).resolves.toHaveLength(1);
    await expect(journal.isJournalOwned("invocation-1")).resolves.toBe(true);
    await expect(journal.readProjectRecoveryStatus(projectId)).resolves.toEqual({
      writeStatus: "recovery_required",
      unresolved: [{ journalId: id, status: "orphaned" }],
    });
    await expect(journal.assertProjectWritable(projectId)).rejects.toMatchObject({
      name: "JournalTransactionError",
      code: ErrorCode.RecoveryRequired,
    });
  });

  it("allows exactly one T1 reserve when two invocations race for the same grant", async () => {
    const journal = new MutationJournal(database, clock);
    const outcomes = await Promise.allSettled([beginReserved(journal), beginReserved(journal)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_journal")).toEqual({ count: 1 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM mutation_journal WHERE grant_id = 'grant-1'"))
      .toEqual({ count: 1 });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-1'"))
      .toEqual({ status: "reserved" });
  });

  it("rolls T2b back to pending when durable tool audit insertion fails", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await beginReserved(journal);
    dbRun(database, `CREATE TRIGGER fail_tool_audit BEFORE INSERT ON audit_entry
      WHEN NEW.action LIKE 'tool:%' BEGIN SELECT RAISE(ABORT, 'audit injected'); END`);
    await expect(journal.commitComposite(id, committedResult(), { kind: "consume", grantId: "grant-1" }))
      .rejects.toThrow();
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "pending" });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-1'")).toEqual({ status: "reserved" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
  });

  it("rolls T2b back when grant consumption loses its reserved state", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await beginReserved(journal);
    dbRun(database, "UPDATE approval_grant SET status = 'revoked' WHERE id = 'grant-1'");
    await expect(journal.commitComposite(id, committedResult(), { kind: "consume", grantId: "grant-1" }))
      .rejects.toMatchObject({ code: ErrorCode.ApprovalInvalid });
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "pending" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM event_outbox")).toEqual({ count: 0 });
  });

  it("rolls T2b back when the late event foreign key write fails", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await beginReserved(journal);
    await expect(journal.commitComposite(
      id,
      committedResult("missing-project" as ProjectId),
      { kind: "consume", grantId: "grant-1" },
    )).rejects.toThrow();
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "pending" });
    expect(dbOne(database, "SELECT status FROM approval_grant WHERE id = 'grant-1'")).toEqual({ status: "reserved" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision_step")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM event_outbox")).toEqual({ count: 0 });
  });
});
