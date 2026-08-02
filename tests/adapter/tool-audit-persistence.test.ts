import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import type { ClockPort, PendingMutationContext, StepIntent } from "@vidcom/core";
import { initializeDatabase, MutationJournal, SqliteToolAuditRepository } from "@vidcom/adapter";

import { dbAll, dbOne, dbRun } from "../support/database";

let root: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
const now = "2026-08-02T00:00:00.000Z";
const projectId = "project_audit" as ProjectId;
const hash = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;
const clock: ClockPort = { now: () => new Date(now) };
const context: PendingMutationContext = {
  toolAudit: {
    schemaVersion: 1,
    invocationId: "invocation-audit-1",
    tool: "save_file",
    level: "write",
    projectId,
    era: "modern",
    protocolVersion: "2025-06-18",
    detail: { path: "compositions/scene-1.html" },
    credentialId: "credential-1",
    invokedAt: now,
  },
};
const steps: StepIntent[] = [{
  ordinal: 0,
  kind: "write",
  path: "compositions/scene-1.html" as RelPath,
  entity: null,
  fromHash: hash("1"),
  toHash: hash("2"),
  previousContent: "before",
}];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-tool-audit-"));
  database = await initializeDatabase(root);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, "/workspace", "project-audit", now, now);
});

async function begin(journal: MutationJournal) {
  return journal.beginComposite({ projectId, actor: "agent" }, steps, context);
}

function result() {
  return {
    projectId,
    actor: "agent" as const,
    steps: steps.map((step) => ({ ...step, status: "written" as const })),
    diagnostics: [],
    event: { type: "file.changed" as const, projectId, payload: { path: steps[0]!.path } },
  };
}

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("SqliteToolAuditRepository", () => {
  it("writes redacted read/failure rows only to app-data with protocol and credential metadata", async () => {
    const repository = new SqliteToolAuditRepository(database);
    await repository.record({
      tool: "list_projects",
      level: "read",
      projectId: null,
      era: "modern",
      protocolVersion: "2025-06-18",
      outcome: "ok",
      errorCode: null,
      detail: { token: "secret", count: 2, workspace: "/Users/person/project" },
      credentialId: "credential-1",
    }, "2026-08-02T00:00:00.000Z");
    await repository.record({
      tool: "save_file",
      level: "write",
      projectId: null,
      era: "legacy",
      protocolVersion: "2024-11-05",
      outcome: "error",
      errorCode: ErrorCode.SchemaInvalid,
      detail: { content: "raw file" },
      credentialId: null,
    }, "2026-08-02T00:00:01.000Z");

    const rows = dbAll<{
      action: string; actor: string; revisionId: number | null; protocolVersion: string;
      outcome: string; errorCode: string | null; detail: string; createdAt: string;
    }>(database, `SELECT action, actor, revision_id AS revisionId, protocol_version AS protocolVersion,
      outcome, error_code AS errorCode, detail, created_at AS createdAt FROM audit_entry ORDER BY id`);
    expect(rows.map(({ detail, ...row }) => ({ ...row, detail: JSON.parse(detail) }))).toEqual([
      {
        action: "tool:list_projects", actor: "agent", revisionId: null, protocolVersion: "2025-06-18",
        outcome: "ok", errorCode: null, createdAt: "2026-08-02T00:00:00.000Z",
        detail: {
          count: 2, credentialId: "credential-1", era: "modern", level: "read",
          token: "[REDACTED]", workspace: "[REDACTED_ABSOLUTE_PATH]",
        },
      },
      {
        action: "tool:save_file", actor: "agent", revisionId: null, protocolVersion: "2024-11-05",
        outcome: "error", errorCode: ErrorCode.SchemaInvalid, createdAt: "2026-08-02T00:00:01.000Z",
        detail: { content: "[REDACTED]", credentialId: null, era: "legacy", level: "write" },
      },
    ]);
  });
});

describe("journal-owned tool audit persistence", () => {
  it("keeps an all-landed outcome indeterminate when terminal audit fails, then retries one-step audit with the same revision", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await begin(journal);
    dbRun(database, `CREATE TRIGGER fail_tool_audit BEFORE INSERT ON audit_entry
      WHEN NEW.action LIKE 'tool:%' BEGIN SELECT RAISE(ABORT, 'injected tool audit failure'); END`);

    await expect(journal.commitComposite(id, result())).rejects.toThrow("Failed query");
    expect(dbOne(database, "SELECT status FROM mutation_journal WHERE id = ?", id)).toEqual({ status: "pending" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 0 });
    await expect(journal.isJournalOwned("invocation-audit-1")).resolves.toBe(true);

    dbRun(database, "DROP TRIGGER fail_tool_audit");
    const envelope = await journal.commitComposite(id, result());
    const rows = dbAll<{ action: string; revisionId: number }>(database,
      "SELECT action, revision_id AS revisionId FROM audit_entry ORDER BY id");
    expect(rows).toEqual([
      { action: "file.write", revisionId: envelope.projectRevision },
      { action: "tool:save_file", revisionId: envelope.projectRevision },
    ]);
    expect(dbOne(database, `SELECT tool.revision_id AS revisionId, mutation.action AS mutationAction
      FROM audit_entry tool JOIN audit_entry mutation ON mutation.revision_id = tool.revision_id
      WHERE tool.action = 'tool:save_file' AND mutation.action = 'file.write'`)).toEqual({
      revisionId: envelope.projectRevision,
      mutationAction: "file.write",
    });
    await expect(journal.commitComposite(id, result())).rejects.toThrow();
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry WHERE action = 'tool:save_file'"))
      .toEqual({ count: 1 });
  });

  it("keeps the existing audit query indexes available to the planner", () => {
    const indexes = dbAll<{ name: string }>(database, "PRAGMA index_list('audit_entry')").map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_audit_project", "idx_audit_action", "idx_audit_created"]));
    const plan = dbAll<{ detail: string }>(database,
      "EXPLAIN QUERY PLAN SELECT * FROM audit_entry WHERE action = 'tool:save_file'");
    expect(plan.some((row) => row.detail.includes("idx_audit_action"))).toBe(true);
  });

  it("hands ownership to the caller only after T2a clears durable context", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await begin(journal);
    await expect(journal.isJournalOwned("invocation-audit-1")).resolves.toBe(true);
    await expect(journal.abortComposite(id, ErrorCode.WriteConflict)).resolves.toEqual(context);
    await expect(journal.isJournalOwned("invocation-audit-1")).resolves.toBe(false);
    expect(dbOne(database, "SELECT tool_audit_json AS audit FROM mutation_journal WHERE id = ?", id))
      .toEqual({ audit: null });
  });

  it("writes one orphan terminal error and retains journal ownership", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await begin(journal);
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired);
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired);

    expect(dbOne(database, `SELECT action, outcome, error_code AS errorCode, revision_id AS revisionId
      FROM audit_entry`)).toEqual({
      action: "tool:save_file",
      outcome: "error",
      errorCode: ErrorCode.RecoveryRequired,
      revisionId: null,
    });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM audit_entry")).toEqual({ count: 1 });
    await expect(journal.isJournalOwned("invocation-audit-1")).resolves.toBe(true);
  });
});
