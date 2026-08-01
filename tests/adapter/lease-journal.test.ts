import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { ErrorCode } from "@vidcom/contracts";
import type { AbsolutePath, ClockPort, MutationIntent } from "@vidcom/core";
import { initializeDatabase, MutationJournal, WorkspaceLease } from "@vidcom/adapter";
import { createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbOne, dbRun } from "../support/database";

let root: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let instant: Date;
let clock: ClockPort;

const projectId = "project_0001" as ProjectId;
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as ContentHash;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-journal-test-"));
  database = await initializeDatabase(root);
  instant = new Date("2026-08-01T00:00:00.000Z");
  clock = { now: () => new Date(instant) };
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, "/workspace", "project", instant.toISOString(), instant.toISOString());
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("WorkspaceLease", () => {
  it("acquires, denies a second holder, renews, asserts and releases", async () => {
    const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
    const workspace = "/workspace" as AbsolutePath;
    const acquired = await lease.acquire(workspace, "host-a:1:boot");
    expect(acquired).toEqual({ ok: true, leaseId: "lease_0001" });
    expect(await lease.acquire(workspace, "host-b:2:boot")).toMatchObject({
      ok: false,
      heldBy: { holderId: "host-a:1:boot" },
    });
    if (!acquired.ok) return;
    expect(await lease.assertHeld(acquired.leaseId)).toBe(true);
    expect(await lease.renew(acquired.leaseId)).toBe(true);
    await lease.release(acquired.leaseId);
    expect(await lease.assertHeld(acquired.leaseId)).toBe(false);
  });

  it("takes an expired lease and records lease.stolen", async () => {
    const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
    const workspace = "/workspace" as AbsolutePath;
    await lease.acquire(workspace, "host-a:1:boot");
    instant = new Date(instant.getTime() + 30_001);
    expect(await lease.acquire(workspace, "host-b:2:boot")).toEqual({
      ok: true,
      leaseId: "lease_0002",
    });
    expect(dbOne(database, "SELECT action, detail FROM audit_entry LIMIT 1")).toEqual({
      action: "lease.stolen",
      detail: JSON.stringify({ previousHolderId: "host-a:1:boot" }),
    });
  });
});

describe("MutationJournal", () => {
  const intent: MutationIntent = {
    projectId,
    kind: "file",
    path: "index.html" as RelPath,
    entity: null,
    fromHash: hash("a"),
    previousContent: "old",
    toHash: hash("b"),
    actor: "user",
  };

  it("begins, lists and aborts a pending intent", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await journal.begin(intent);
    expect(await journal.listPending()).toEqual([
      { id, ...intent, previousContent: new TextEncoder().encode("old"), stagedAsset: null },
    ]);
    await journal.abort(id, ErrorCode.WriteConflict);
    expect(await journal.listPending()).toEqual([]);
    expect(dbOne(database, "SELECT outcome, error_code FROM audit_entry LIMIT 1")).toEqual({
      outcome: "error",
      error_code: ErrorCode.WriteConflict,
    });
  });

  it("commits journal, revision, blob, audit and event in one transaction", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await journal.begin(intent);
    expect(
      await journal.commit(id, {
        ...intent,
        event: { type: "file.changed", projectId, payload: { path: "index.html" } },
      }),
    ).toBe(1);
    expect(dbOne(database, "SELECT status FROM mutation_journal LIMIT 1")).toEqual({
      status: "committed",
    });
    expect(dbAll(database, "SELECT * FROM revision")).toHaveLength(1);
    expect(dbOne(database, "SELECT byte_size FROM revision_blob LIMIT 1")).toEqual({ byte_size: 3 });
    expect(dbOne(database, "SELECT outcome FROM audit_entry LIMIT 1")).toEqual({ outcome: "ok" });
    expect(dbOne(database, "SELECT type FROM event_outbox LIMIT 1")).toEqual({ type: "file.changed" });
  });

  it("rolls back every commit row when a late event insert fails", async () => {
    const journal = new MutationJournal(database, clock);
    const id = await journal.begin(intent);
    await expect(
      journal.commit(id, {
        ...intent,
        event: { type: "invalid" as "file.changed", projectId, payload: {} },
      }),
    ).rejects.toThrow();
    expect(await journal.listPending()).toHaveLength(1);
    expect(dbAll(database, "SELECT * FROM revision")).toEqual([]);
    expect(dbAll(database, "SELECT * FROM revision_blob")).toEqual([]);
    expect(dbAll(database, "SELECT * FROM audit_entry")).toEqual([]);
    expect(dbAll(database, "SELECT * FROM event_outbox")).toEqual([]);
  });
});
