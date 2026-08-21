// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import type { ClockPort, JournalId, StepIntent, StepResult } from "@vidcom/core";
import {
  initializeDatabase,
  MutationJournal,
  SqlitePendingMountStore,
  sweepPendingMounts,
} from "@vidcom/adapter";

import { dbAll, dbRun } from "../support/database";

let root: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let instant: Date;

const projectId = "project_retention" as ProjectId;
const hash = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;
const clock: ClockPort = { now: () => new Date(instant) };
const authority = { leaseId: "lease-retention" };
const DAY = 24 * 60 * 60 * 1_000;

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

function committedResult() {
  const committedSteps: StepResult[] = steps.map((step) => ({ ...step, status: "written" }));
  return {
    projectId,
    actor: "user" as const,
    steps: committedSteps,
    diagnostics: [],
    event: { type: "project.changed" as const, projectId, payload: { source: "composite" } },
  };
}

async function openPending(journal: MutationJournal, operationId: string): Promise<void> {
  const id = await journal.beginComposite(
    { projectId, actor: "user" },
    steps,
    { toolAudit: null },
    authority,
    undefined,
    {
      kind: "open",
      operationId,
      record: {
        operationId,
        projectId,
        assetPath: `assets/video/${operationId}.mp4` as RelPath,
        assetContentHash: hash("8"),
        uploadFingerprint: hash("9"),
        atSeconds: 0,
        trackIndex: 0,
      },
    },
  );
  await journal.commitComposite(id, committedResult());
}

async function close(journal: MutationJournal, operationId: string, sceneId: string): Promise<void> {
  const id: JournalId = await journal.beginComposite(
    { projectId, actor: "user" },
    steps,
    { toolAudit: null },
    authority,
    undefined,
    { kind: "close", operationId, sceneId, previousFailure: null },
  );
  await journal.commitComposite(id, committedResult());
}

function states(): Array<{ operationId: string; state: string; code: string | null }> {
  return dbAll(database, `SELECT operation_id AS operationId, state, last_error_code AS code
    FROM pending_mount ORDER BY operation_id`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-pending-retention-"));
  database = await initializeDatabase(root);
  instant = new Date("2026-08-02T00:00:00.000Z");
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  projectId, "/workspace", "retention", instant.toISOString(), instant.toISOString());
  dbRun(database, `INSERT INTO workspace_lease
    (workspace_root, lease_id, holder_id, acquired_at, expires_at)
    VALUES ('/workspace', ?, 'test', ?, '2026-09-02T06:00:00.000Z')`,
  authority.leaseId, instant.toISOString());
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("sweepPendingMounts", () => {
  it("abandons uploads left over seven days and names the reason of the ones it keeps", async () => {
    const journal = new MutationJournal(database, clock);
    await openPending(journal, "01K1AAAAAAAAAAAAAAAAAAAAAA");
    instant = new Date(instant.getTime() + 6 * DAY);
    await openPending(journal, "01K1BBBBBBBBBBBBBBBBBBBBBB");
    const store = new SqlitePendingMountStore(database, clock);
    await store.markFailed(projectId, "01K1BBBBBBBBBBBBBBBBBBBBBB", { code: "mount_failed", message: "ffprobe failed" });
    instant = new Date(instant.getTime() + 2 * DAY);
    await openPending(journal, "01K1CCCCCCCCCCCCCCCCCCCCCC");

    // Eight days after the first upload, one day after the second and the third.
    expect(await sweepPendingMounts(database, new Date(instant))).toMatchObject({ abandoned: 1, deleted: 0 });
    expect(states()).toEqual([
      { operationId: "01K1AAAAAAAAAAAAAAAAAAAAAA", state: "abandoned", code: "abandoned" },
      // A recorded reason is never overwritten by the generic interrupted marker.
      { operationId: "01K1BBBBBBBBBBBBBBBBBBBBBB", state: "uploaded_unmounted", code: "mount_failed" },
      { operationId: "01K1CCCCCCCCCCCCCCCCCCCCCC", state: "uploaded_unmounted", code: "interrupted" },
    ]);

    // The asset row that was abandoned is still addressable, so Media can explain it.
    await expect(store.lookup(projectId, "01K1AAAAAAAAAAAAAAAAAAAAAA")).resolves.toMatchObject({
      state: "active",
      record: { state: "abandoned" },
    });
  });

  it("keeps a mounted tombstone for a day, then deletes it without losing the operation", async () => {
    const journal = new MutationJournal(database, clock);
    const store = new SqlitePendingMountStore(database, clock);
    await openPending(journal, "01K1DDDDDDDDDDDDDDDDDDDDDD");
    await close(journal, "01K1DDDDDDDDDDDDDDDDDDDDDD", "scene-d");

    instant = new Date(instant.getTime() + 23 * 60 * 60 * 1_000);
    expect(await sweepPendingMounts(database, new Date(instant))).toMatchObject({ deleted: 0 });
    await expect(store.lookup(projectId, "01K1DDDDDDDDDDDDDDDDDDDDDD")).resolves.toMatchObject({
      state: "active",
      record: { state: "mounted", mountedSceneId: "scene-d" },
    });

    instant = new Date(instant.getTime() + 2 * 60 * 60 * 1_000);
    expect(await sweepPendingMounts(database, new Date(instant))).toMatchObject({ deleted: 1 });
    // The row is gone, but the journal still proves the operation existed, so a late
    // retry is refused rather than treated as a brand new upload.
    await expect(store.lookup(projectId, "01K1DDDDDDDDDDDDDDDDDDDDDD")).resolves.toEqual({ state: "expired" });
  });

  it("deletes abandoned rows after seven days and leaves younger ones alone", async () => {
    const journal = new MutationJournal(database, clock);
    const store = new SqlitePendingMountStore(database, clock);
    await openPending(journal, "01K1EEEEEEEEEEEEEEEEEEEEEE");
    await store.abandon(projectId, "01K1EEEEEEEEEEEEEEEEEEEEEE", "user cancelled the upload");
    instant = new Date(instant.getTime() + 6 * DAY);
    await openPending(journal, "01K1FFFFFFFFFFFFFFFFFFFFFF");
    await store.abandon(projectId, "01K1FFFFFFFFFFFFFFFFFFFFFF", "user cancelled the upload");

    instant = new Date(instant.getTime() + 2 * DAY);
    expect(await sweepPendingMounts(database, new Date(instant))).toMatchObject({ deleted: 1, abandoned: 0 });
    expect(states()).toEqual([
      { operationId: "01K1FFFFFFFFFFFFFFFFFFFFFF", state: "abandoned", code: "abandoned" },
    ]);
    await expect(store.lookup(projectId, "01K1EEEEEEEEEEEEEEEEEEEEEE")).resolves.toEqual({ state: "expired" });
  });
});
