import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type RelPath } from "@vidcom/contracts";
import {
  WorkspaceMutationCoordinator,
  type AbsolutePath,
  type ClockPort,
  type JournalId,
  type WorkspacePort,
} from "@vidcom/core";
import {
  FsProjectDirectoryAdapter,
  initializeDatabase,
  LargePreviousContentStore,
  WorkspaceFs,
  WorkspaceLease,
  WorkspaceOperationJournal,
} from "@vidcom/adapter";

import { dbAll, dbOne } from "../support/database";
import { createSequentialIdPort } from "../support/deterministic";

const now = "2026-08-04T00:00:00.000Z";
const clock: ClockPort = { now: () => new Date(now) };
const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

let root: string;
let workspaceRoot: AbsolutePath;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let workspace: WorkspaceFs;
let lease: WorkspaceLease;
let leaseId: string;
let journal: WorkspaceOperationJournal;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-workspace-operation-"));
  workspaceRoot = path.join(root, "workspace") as AbsolutePath;
  await mkdir(workspaceRoot, { recursive: true });
  const appData = path.join(root, "app-data");
  database = await initializeDatabase(appData);
  workspace = new WorkspaceFs(workspaceRoot);
  lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot, "test:workspace-operation");
  if (!acquired.ok) throw new Error("workspace lease was denied");
  leaseId = acquired.leaseId;
  journal = new WorkspaceOperationJournal(database, clock, new LargePreviousContentStore(appData));
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

function coordinator(workspacePort: WorkspacePort = workspace) {
  return new WorkspaceMutationCoordinator({
    workspace: workspacePort,
    journal,
    lease,
    leaseId,
    hashContent: hash,
  });
}

describe("WorkspaceMutationCoordinator with real SQLite and filesystem", () => {
  it("restores every earlier file when agent-kit publish fails at step N", async () => {
    const originals = new Map([
      ["AGENTS.md", "agents-old"],
      ["CLAUDE.md", "claude-old"],
      ["AGENTS.vidcom.md", "router-old"],
    ]);
    for (const [filename, content] of originals) await writeFile(path.join(workspaceRoot, filename), content);
    let publishes = 0;
    const failing = new Proxy(workspace, {
      get(target, property) {
        if (property === "publishCaptured") {
          return async (...args: Parameters<WorkspaceFs["publishCaptured"]>) => {
            publishes += 1;
            if (publishes === 3) throw new Error("injected step N failure");
            return target.publishCaptured(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkspacePort;

    const result = await coordinator(failing).mutate({
      workspaceRoot,
      actor: "system",
      action: "agent-kit.install",
      writes: [...originals].map(([filename, content]) => ({
        path: filename as RelPath,
        content: `${content}-new`,
        fromHash: hash(content),
      })),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    for (const [filename, content] of originals) {
      expect(await readFile(path.join(workspaceRoot, filename), "utf8")).toBe(content);
    }
    expect(dbAll(database, "SELECT status FROM workspace_operation")).toEqual([{ status: "recovered" }]);
    expect(dbAll(database, "SELECT status FROM workspace_operation_step ORDER BY ordinal"))
      .toEqual([{ status: "rolled_back" }, { status: "rolled_back" }, { status: "rolled_back" }]);
  });

  it("allows exactly one concurrent operation to own a target", async () => {
    await writeFile(path.join(workspaceRoot, "AGENTS.md"), "old");
    const request = (content: string) => coordinator().mutate({
      workspaceRoot,
      actor: "system",
      action: "agent-kit.install",
      writes: [{ path: "AGENTS.md" as RelPath, content, fromHash: hash("old") }],
    });
    const results = await Promise.all([request("first"), request("second")]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toMatchObject([{ error: { code: "write_conflict" } }]);
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_operation")).toEqual({ count: 1 });
  });

  it("rejects the second concurrent journal begin for the same unresolved path", async () => {
    const intent = {
      workspaceRoot,
      kind: "agent_kit_files" as const,
      projectId: null,
      fromPath: null,
      toPath: null,
      stagingPath: null,
      actor: "system" as const,
      action: "agent-kit.install",
    };
    const steps = [{
      ordinal: 0,
      path: "AGENTS.md" as RelPath,
      fromHash: null,
      toHash: hash("next"),
      previousContent: null,
    }];
    const attempts = await Promise.allSettled([
      journal.begin(intent, steps, { leaseId }),
      journal.begin(intent, steps, { leaseId }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected"))
      .toMatchObject([{ reason: { code: "write_conflict" } }]);
  });

  it("recovers a crash after final publish but before the final written marker as one terminal batch", async () => {
    await writeFile(path.join(workspaceRoot, "AGENTS.md"), "old-agents");
    await writeFile(path.join(workspaceRoot, "CLAUDE.md"), "old-claude");
    const paths = ["AGENTS.md", "CLAUDE.md"] as const;
    const old = ["old-agents", "old-claude"] as const;
    const next = ["new-agents", "new-claude"] as const;
    const operationId = await journal.begin({
      workspaceRoot,
      kind: "agent_kit_files",
      projectId: null,
      fromPath: null,
      toPath: null,
      stagingPath: null,
      actor: "system",
      action: "agent-kit.install",
    }, paths.map((target, ordinal) => ({
      ordinal,
      path: target as RelPath,
      fromHash: hash(old[ordinal]),
      toHash: hash(next[ordinal]),
      previousContent: old[ordinal],
    })), { leaseId });
    for (const [ordinal, target] of paths.entries()) {
      const resolved = await workspace.resolveWorkspace(workspaceRoot, target as RelPath, "workspace-agent-kit");
      if (!resolved.ok) throw new Error("test target did not resolve");
      const captured = await workspace.captureForMutation(
        resolved.value,
        hash(old[ordinal]),
        operationId as unknown as JournalId,
        ordinal,
      );
      if (!captured.ok) throw new Error("test target did not capture");
      await journal.markStepCaptured(operationId, ordinal, captured.value.rollbackPath, captured.value.capturedHash);
      expect(await workspace.publishCaptured(captured.value, next[ordinal])).toBe(true);
      if (ordinal < paths.length - 1) await journal.markStepWritten(operationId, ordinal);
    }
    const reports = await coordinator().recoverPending(workspaceRoot);
    expect(reports).toEqual([{ operationId, terminal: "recovered" }]);
    expect(dbAll(database, "SELECT status FROM workspace_operation")).toEqual([{ status: "recovered" }]);
    expect(dbAll(database, "SELECT status FROM workspace_operation_step ORDER BY ordinal"))
      .toEqual([{ status: "written" }, { status: "written" }]);
    expect(await readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8")).toBe("new-agents");
    expect(await readFile(path.join(workspaceRoot, "CLAUDE.md"), "utf8")).toBe("new-claude");
  });

  it("commits workspace audit without revision or DomainEvent", async () => {
    const result = await coordinator().mutate({
      workspaceRoot,
      actor: "system",
      action: "agent-kit.install",
      writes: [{ path: "AGENTS.vidcom.md" as RelPath, content: "router", fromHash: null }],
    });
    expect(result).toMatchObject({ ok: true });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM event_outbox")).toEqual({ count: 0 });
    expect(dbAll(database, "SELECT project_id AS projectId, action FROM audit_entry"))
      .toEqual([{ projectId: null, action: "agent-kit.install" }]);
  });

  it("keeps create staging hidden, publishes a complete project, then recovers the DB settle boundary", async () => {
    const operationId = await journal.begin({
      workspaceRoot,
      kind: "project_create",
      projectId: null,
      fromPath: null,
      toPath: "demo",
      stagingPath: null,
      actor: "user",
      action: "project.create",
    }, [{
      ordinal: 0,
      path: "demo" as RelPath,
      fromHash: null,
      toHash: hash("complete-project"),
      previousContent: null,
    }], { leaseId });
    const directories = new FsProjectDirectoryAdapter(workspaceRoot);
    const staged = await directories.stageCreate(workspaceRoot, "demo", operationId);
    await directories.writeStagedFiles(staged.stagingRoot, [
      { path: "vidcom.json" as RelPath, content: "{\"id\":\"demo\"}\n" },
      { path: "hyperframes.json" as RelPath, content: "{}\n" },
      { path: "index.html" as RelPath, content: "<main>complete</main>" },
    ]);

    await expect(readFile(staged.finalRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await journal.read(operationId))?.status).toBe("pending");
    await directories.publishCreate(staged.stagingRoot, staged.finalRoot);
    expect(await readFile(path.join(staged.finalRoot, "index.html"), "utf8")).toBe("<main>complete</main>");
    expect((await journal.read(operationId))?.status).toBe("pending");
    await journal.markStepCaptured(operationId, 0, null, null);
    await journal.markStepWritten(operationId, 0);
    await journal.recover(operationId);
    expect(await journal.read(operationId)).toBeNull();
    expect(dbAll(database, "SELECT status FROM workspace_operation")).toEqual([{ status: "recovered" }]);
    expect(await readFile(path.join(staged.finalRoot, "vidcom.json"), "utf8")).toBe("{\"id\":\"demo\"}\n");
  });

  it("removes only operation-owned staging and aborts the journal after a pre-rename crash", async () => {
    const directories = new FsProjectDirectoryAdapter(workspaceRoot);
    const operationId = await journal.begin({
      workspaceRoot,
      kind: "project_create",
      projectId: null,
      fromPath: null,
      toPath: "crash",
      stagingPath: null,
      actor: "user",
      action: "project.create",
    }, [{
      ordinal: 0,
      path: "crash" as RelPath,
      fromHash: null,
      toHash: hash("complete"),
      previousContent: null,
    }], { leaseId });
    const staged = await directories.stageCreate(workspaceRoot, "crash", operationId);
    await directories.writeStagedFiles(staged.stagingRoot, [
      { path: "index.html" as RelPath, content: "complete" },
    ]);
    await directories.removeOwned(staged.stagingRoot);
    await journal.abort(operationId, ErrorCode.StorageUnavailable);
    await expect(readFile(staged.stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(staged.finalRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(dbAll(database, "SELECT status FROM workspace_operation")).toEqual([{ status: "aborted" }]);
    await expect(directories.removeOwned(workspaceRoot)).rejects.toThrow();
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
  });
});
