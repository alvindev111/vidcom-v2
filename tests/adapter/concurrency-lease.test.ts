import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import { WriteAuthority, type AbsolutePath, type ClockPort, type ProjectRef } from "@vidcom/core";
import { initializeDatabase, MutationJournal, WorkspaceFs, WorkspaceLease } from "@vidcom/adapter";
import { createSequentialIdPort } from "../support/deterministic";
import { dbAll, dbRun } from "../support/database";

const digest = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

let root: string;
let workspaceRoot: string;
let projectRoot: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let instant: Date;
let clock: ClockPort;
let ref: ProjectRef;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-concurrency-"));
  workspaceRoot = path.join(root, "workspace");
  projectRoot = path.join(workspaceRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
  await writeFile(path.join(projectRoot, "vidcom.json"), '{"id":"project_concurrent"}\n');
  await writeFile(path.join(projectRoot, "index.html"), "old");
  database = await initializeDatabase(path.join(root, "app-data"));
  instant = new Date("2026-08-01T00:00:00.000Z");
  clock = { now: () => new Date(instant) };
  ref = {
    id: "project_concurrent" as ProjectId,
    slug: "project",
    root: projectRoot as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  dbRun(database, `INSERT INTO project_registry
    (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  ref.id, workspaceRoot, ref.slug, instant.toISOString(), instant.toISOString());
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("real WriteAuthority concurrency and workspace lease", () => {
  it("allows one expected hash winner, denies a live peer, and transfers authority after TTL", async () => {
    const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
    const journal = new MutationJournal(database, clock);
    const lease = new WorkspaceLease(database, clock, createSequentialIdPort());
    const leaseA = await lease.acquire(workspaceRoot as AbsolutePath, "daemon-a:1:boot");
    expect(leaseA).toEqual({ ok: true, leaseId: "lease_0001" });
    if (!leaseA.ok) return;
    expect(await lease.acquire(workspaceRoot as AbsolutePath, "daemon-b:2:boot")).toMatchObject({
      ok: false,
      heldBy: { holderId: "daemon-a:1:boot" },
    });

    const authorityA = new WriteAuthority({
      workspace,
      journal,
      compositeJournal: journal,
      lease,
      leaseId: leaseA.leaseId,
      hashContent: digest,
      invalidate() {},
      notifyEvents() {},
    });
    instant = new Date(instant.getTime() + 30_001);
    const leaseB = await lease.acquire(workspaceRoot as AbsolutePath, "daemon-b:2:boot");
    expect(leaseB).toEqual({ ok: true, leaseId: "lease_0003" });
    if (!leaseB.ok) return;
    await expect(authorityA.mutate({
      kind: "file",
      ref,
      path: "index.html" as RelPath,
      content: "stale daemon",
      expectedContentHash: digest("old"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.WorkspaceLeaseLost },
    });
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("old");

    const authorityB = new WriteAuthority({
      workspace,
      journal,
      compositeJournal: journal,
      lease,
      leaseId: leaseB.leaseId,
      hashContent: digest,
      invalidate() {},
      notifyEvents() {},
    });
    const mutate = (content: string) => authorityB.mutate({
      kind: "file" as const,
      ref,
      path: "index.html" as RelPath,
      content,
      expectedContentHash: digest("old"),
    }, "user");
    const results = await Promise.all([mutate("first"), mutate("second")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: ErrorCode.WriteConflict }) }),
    ]);
    expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toBe("first");
    expect(dbAll(database, "SELECT * FROM revision")).toHaveLength(1);
    expect(dbAll(database, "SELECT action FROM audit_entry ORDER BY id")).toEqual([
      { action: "lease.stolen" },
      { action: "file.write" },
    ]);
  });
});
