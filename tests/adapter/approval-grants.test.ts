import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  ApprovalService,
  type ApprovalGrantRecord,
  type ClockPort,
  type GrantBinding,
  type StepIntent,
} from "@vidcom/core";
import { initializeDatabase, MutationJournal, SqliteApprovalGrantStore } from "@vidcom/adapter";

import { dbOne, dbRun } from "../support/database";

let root: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
const projectId = "project_approval_sqlite" as ProjectId;
const now = "2026-08-02T00:00:00.000Z";
const clock: ClockPort = { now: () => new Date(now) };
const hash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}` as ContentHash;
const binding: GrantBinding = {
  tool: "delete_file",
  projectId,
  target: "index.html",
  expectedRevision: 0,
  planDigest: hash("a"),
  targetHashes: { ["index.html" as RelPath]: hash("1") },
};
const steps: StepIntent[] = [{
  ordinal: 0,
  kind: "delete",
  path: "index.html" as RelPath,
  entity: null,
  fromHash: hash("1"),
  toHash: null,
  previousContent: "before",
}];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-approval-grants-"));
  database = await initializeDatabase(root);
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, '/workspace', 'project', ?, ?)`,
  projectId, now, now);
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

function requested(id: string, expiresAt = "2026-08-02T00:10:00.000Z"): ApprovalGrantRecord {
  return {
    id,
    binding,
    summary: id,
    status: "requested",
    approver: null,
    createdAt: now,
    expiresAt,
  };
}

describe("SqliteApprovalGrantStore", () => {
  it("persists canonical requests and permits exactly one issue replay", async () => {
    const store = new SqliteApprovalGrantStore(database);
    const service = new ApprovalService({
      grants: store,
      clock,
      ids: { newId: () => "grant_request" },
    });
    await service.request(binding, "Delete index");
    await expect(service.issue("grant_request", "cli")).resolves.toEqual({ ok: true, value: "grant_request" });
    await expect(service.issue("grant_request", "cli")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.ApprovalInvalid },
    });
    await expect(store.read("grant_request")).resolves.toMatchObject({
      status: "issued",
      approver: "cli",
      binding,
    });
  });

  it("lets exactly one revoke or reserve CAS win", async () => {
    const store = new SqliteApprovalGrantStore(database);
    await store.create(requested("grant_race"));
    await store.issue("grant_race", "cli", now, "2026-08-02T00:05:00.000Z");
    const journal = new MutationJournal(database, clock);
    const outcomes = await Promise.allSettled([
      journal.beginComposite(
        { projectId, actor: "agent" },
        steps,
        { toolAudit: null },
        { kind: "reserve", grantId: "grant_race", binding },
      ),
      store.revoke("grant_race"),
    ]);
    const status = (await store.read("grant_race"))?.status;
    expect(["reserved", "revoked"]).toContain(status);
    if (status === "reserved") {
      expect(outcomes[0]?.status).toBe("fulfilled");
      expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: false });
    } else {
      expect(outcomes[0]?.status).toBe("rejected");
      expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: true });
    }
  });

  it("reuses an issued grant only after a verified abort release", async () => {
    const store = new SqliteApprovalGrantStore(database);
    await store.create(requested("grant_reuse"));
    await store.issue("grant_reuse", "ui", now, "2026-08-02T00:05:00.000Z");
    const journal = new MutationJournal(database, clock);
    const first = await journal.beginComposite(
      { projectId, actor: "agent" }, steps, { toolAudit: null },
      { kind: "reserve", grantId: "grant_reuse", binding },
    );
    await journal.abortComposite(first, ErrorCode.StorageUnavailable, {
      kind: "release", grantId: "grant_reuse",
    });
    await expect(journal.beginComposite(
      { projectId, actor: "agent" }, steps, { toolAudit: null },
      { kind: "reserve", grantId: "grant_reuse", binding },
    )).resolves.toEqual(2);
    expect((await store.read("grant_reuse"))?.status).toBe("reserved");
  });

  it("rejects binding/hash/revision mismatches in the final T1 authority", async () => {
    const store = new SqliteApprovalGrantStore(database);
    await store.create(requested("grant_binding"));
    await store.issue("grant_binding", "cli", now, "2026-08-02T00:05:00.000Z");
    const journal = new MutationJournal(database, clock);
    await expect(journal.beginComposite(
      { projectId, actor: "agent" }, steps, { toolAudit: null },
      { kind: "reserve", grantId: "grant_binding", binding: { ...binding, target: "other.html" } },
    )).rejects.toMatchObject({ code: ErrorCode.ApprovalInvalid });
    await expect(journal.beginComposite(
      { projectId, actor: "agent" }, steps, { toolAudit: null },
      {
        kind: "reserve",
        grantId: "grant_binding",
        binding: { ...binding, targetHashes: { ["index.html" as RelPath]: hash("9") } },
      },
    )).rejects.toMatchObject({ code: ErrorCode.ApprovalInvalid });
    dbRun(database, `INSERT INTO revision
      (project_id, kind, path, entity, content_hash, parent_revision, actor, summary, created_at)
      VALUES (?, 'file', 'index.html', NULL, ?, NULL, 'user', NULL, ?)`, projectId, hash("2"), now);
    await expect(journal.beginComposite(
      { projectId, actor: "agent" }, steps, { toolAudit: null },
      { kind: "reserve", grantId: "grant_binding", binding },
    )).rejects.toMatchObject({ code: ErrorCode.WriteConflict });
  });

  it("retains an old invalidated grant linked to an unresolved orphan", async () => {
    const store = new SqliteApprovalGrantStore(database);
    await store.create(requested("grant_keep"));
    dbRun(database, "UPDATE approval_grant SET status = 'issued' WHERE id = 'grant_keep'");
    const journal = new MutationJournal(database, clock);
    const id = await journal.beginComposite(
      { projectId, actor: "agent" }, steps, { toolAudit: null },
      { kind: "reserve", grantId: "grant_keep", binding },
    );
    await journal.orphanComposite(id, ErrorCode.RecoveryRequired, {
      kind: "invalidate", grantId: "grant_keep", reason: "orphaned",
    });
    dbRun(database, "UPDATE approval_grant SET expires_at = '2026-07-01T00:00:00.000Z' WHERE id = 'grant_keep'");
    await expect(store.cleanupTerminal("2026-08-01T00:00:00.000Z")).resolves.toBe(0);
    expect((await store.read("grant_keep"))?.status).toBe("invalidated");
    expect(dbOne(database, "SELECT grant_id AS grantId FROM mutation_journal WHERE id = ?", id))
      .toEqual({ grantId: "grant_keep" });
  });
});
