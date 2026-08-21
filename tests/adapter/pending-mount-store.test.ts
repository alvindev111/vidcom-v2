// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import type { ClockPort, JournalId, StepIntent, StepResult } from "@vidcom/core";
import { initializeDatabase, MutationJournal, SqlitePendingMountStore } from "@vidcom/adapter";

import { dbOne, dbRun } from "../support/database";

let root: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let instant: Date;

const projectId = "project_pending" as ProjectId;
const otherProjectId = "project_other" as ProjectId;
const hash = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;
const clock: ClockPort = { now: () => new Date(instant) };
const authority = { leaseId: "lease-pending" };

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
];

function committedResult(owner: ProjectId = projectId) {
  const committedSteps: StepResult[] = steps.map((step) => ({ ...step, status: "written" }));
  return {
    projectId: owner,
    actor: "user" as const,
    steps: committedSteps,
    diagnostics: [],
    event: { type: "project.changed" as const, projectId: owner, payload: { source: "composite" } },
  };
}

/** Opens a pending row the only way production can: a committed journal transition. */
async function openPending(
  journal: MutationJournal,
  operationId: string,
  overrides: { owner?: ProjectId; atSeconds?: number; trackIndex?: number } = {},
): Promise<void> {
  const owner = overrides.owner ?? projectId;
  const id = await journal.beginComposite(
    { projectId: owner, actor: "user" },
    steps,
    { toolAudit: null },
    authority,
    undefined,
    {
      kind: "open",
      operationId,
      record: {
        operationId,
        projectId: owner,
        assetPath: `assets/video/${operationId}.mp4` as RelPath,
        assetContentHash: hash("8"),
        uploadFingerprint: hash("9"),
        atSeconds: overrides.atSeconds ?? 0,
        trackIndex: overrides.trackIndex ?? 0,
      },
    },
  );
  await journal.commitComposite(id, committedResult(owner));
}

async function beginClose(journal: MutationJournal, operationId: string, sceneId: string): Promise<JournalId> {
  return journal.beginComposite(
    { projectId, actor: "user" },
    steps,
    { toolAudit: null },
    authority,
    undefined,
    { kind: "close", operationId, sceneId, previousFailure: null },
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-pending-mount-"));
  database = await initializeDatabase(root);
  instant = new Date("2026-08-02T00:00:00.000Z");
  for (const [id, slug] of [[projectId, "pending"], [otherProjectId, "other"]] as const) {
    dbRun(database, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    id, "/workspace", slug, instant.toISOString(), instant.toISOString());
  }
  dbRun(database, `INSERT INTO workspace_lease
    (workspace_root, lease_id, holder_id, acquired_at, expires_at)
    VALUES ('/workspace', ?, 'test', ?, '2026-08-02T06:00:00.000Z')`,
  authority.leaseId, instant.toISOString());
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("SqlitePendingMountStore", () => {
  it("lists only unmounted rows oldest-first and keeps tombstones out of the collection", async () => {
    const journal = new MutationJournal(database, clock);
    const store = new SqlitePendingMountStore(database, clock);
    await openPending(journal, "01K1AAAAAAAAAAAAAAAAAAAAAA");
    instant = new Date("2026-08-02T00:01:00.000Z");
    await openPending(journal, "01K1BBBBBBBBBBBBBBBBBBBBBB", { atSeconds: 2.5, trackIndex: 1 });
    instant = new Date("2026-08-02T00:02:00.000Z");
    await openPending(journal, "01K1CCCCCCCCCCCCCCCCCCCCCC");
    await openPending(journal, "01K1DDDDDDDDDDDDDDDDDDDDDD", { owner: otherProjectId });

    await journal.commitComposite(
      await beginClose(journal, "01K1AAAAAAAAAAAAAAAAAAAAAA", "scene-mounted"),
      committedResult(),
    );
    await store.abandon(projectId, "01K1CCCCCCCCCCCCCCCCCCCCCC", "user cancelled the upload");

    await expect(store.listPending(projectId)).resolves.toMatchObject([
      { operationId: "01K1BBBBBBBBBBBBBBBBBBBBBB", state: "uploaded_unmounted", atSeconds: 2.5, trackIndex: 1 },
    ]);
    await expect(store.listPending(otherProjectId)).resolves.toMatchObject([
      { operationId: "01K1DDDDDDDDDDDDDDDDDDDDDD" },
    ]);
    await expect(store.lookup(projectId, "01K1AAAAAAAAAAAAAAAAAAAAAA")).resolves.toMatchObject({
      state: "active",
      record: { state: "mounted", mountedSceneId: "scene-mounted" },
    });
    await expect(store.lookup(projectId, "01K1CCCCCCCCCCCCCCCCCCCCCC")).resolves.toMatchObject({
      state: "active",
      record: { state: "abandoned", lastFailure: { message: "user cancelled the upload" } },
    });
    await expect(store.lookup(otherProjectId, "01K1AAAAAAAAAAAAAAAAAAAAAA")).resolves.toEqual({ state: "never-seen" });
  });

  it("repeats abandon idempotently but refuses mounted rows and another project's operation", async () => {
    const journal = new MutationJournal(database, clock);
    const store = new SqlitePendingMountStore(database, clock);
    await openPending(journal, "01K1EEEEEEEEEEEEEEEEEEEEEE");
    await openPending(journal, "01K1FFFFFFFFFFFFFFFFFFFFFF");

    await store.abandon(projectId, "01K1EEEEEEEEEEEEEEEEEEEEEE", "abandoned by the studio");
    await expect(store.abandon(projectId, "01K1EEEEEEEEEEEEEEEEEEEEEE", "abandoned again")).resolves.toBeUndefined();
    expect(dbOne(database, "SELECT last_error_message AS message FROM pending_mount WHERE operation_id = ?",
      "01K1EEEEEEEEEEEEEEEEEEEEEE")).toEqual({ message: "abandoned by the studio" });
    await expect(store.markFailed(projectId, "01K1EEEEEEEEEEEEEEEEEEEEEE", { code: "mount_failed", message: "late" }))
      .rejects.toMatchObject({ code: ErrorCode.WriteConflict });

    await journal.commitComposite(
      await beginClose(journal, "01K1FFFFFFFFFFFFFFFFFFFFFF", "scene-f"),
      committedResult(),
    );
    await expect(store.abandon(projectId, "01K1FFFFFFFFFFFFFFFFFFFFFF", "too late"))
      .rejects.toMatchObject({ code: ErrorCode.WriteConflict });
    expect(dbOne(database, "SELECT state FROM pending_mount WHERE operation_id = ?", "01K1FFFFFFFFFFFFFFFFFFFFFF"))
      .toEqual({ state: "mounted" });

    await openPending(journal, "01K1GGGGGGGGGGGGGGGGGGGGGG");
    await expect(store.abandon(otherProjectId, "01K1GGGGGGGGGGGGGGGGGGGGGG", "cross project"))
      .rejects.toMatchObject({ code: ErrorCode.WriteConflict });
    await expect(store.markFailed(otherProjectId, "01K1GGGGGGGGGGGGGGGGGGGGGG", { code: "x", message: "y" }))
      .rejects.toMatchObject({ code: ErrorCode.WriteConflict });
    expect(dbOne(database, "SELECT state FROM pending_mount WHERE operation_id = ?", "01K1GGGGGGGGGGGGGGGGGGGGGG"))
      .toEqual({ state: "uploaded_unmounted" });
  });

  it("lets exactly one side win an abandon/close race in either order", async () => {
    const journal = new MutationJournal(database, clock);
    const store = new SqlitePendingMountStore(database, clock);
    await openPending(journal, "01K1HHHHHHHHHHHHHHHHHHHHHH");

    const closeId = await beginClose(journal, "01K1HHHHHHHHHHHHHHHHHHHHHH", "scene-h");
    await store.abandon(projectId, "01K1HHHHHHHHHHHHHHHHHHHHHH", "abandoned mid-mount");
    await expect(journal.commitComposite(closeId, committedResult()))
      .rejects.toMatchObject({ code: ErrorCode.WriteConflict });
    await journal.abortComposite(closeId, ErrorCode.WriteConflict);
    expect(dbOne(database, "SELECT state FROM pending_mount WHERE operation_id = ?", "01K1HHHHHHHHHHHHHHHHHHHHHH"))
      .toEqual({ state: "abandoned" });

    await openPending(journal, "01K1JJJJJJJJJJJJJJJJJJJJJJ");
    await journal.commitComposite(
      await beginClose(journal, "01K1JJJJJJJJJJJJJJJJJJJJJJ", "scene-j"),
      committedResult(),
    );
    await expect(store.abandon(projectId, "01K1JJJJJJJJJJJJJJJJJJJJJJ", "abandon after close"))
      .rejects.toMatchObject({ code: ErrorCode.WriteConflict });
    expect(dbOne(database, `SELECT state, mounted_scene_id AS sceneId FROM pending_mount WHERE operation_id = ?`,
      "01K1JJJJJJJJJJJJJJJJJJJJJJ")).toEqual({ state: "mounted", sceneId: "scene-j" });
  });
});
