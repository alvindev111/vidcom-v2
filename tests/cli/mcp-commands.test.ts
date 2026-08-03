import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AppDataBackupStore,
  initializeDatabase,
  MutationJournal,
  SqliteApprovalGrantStore,
  WorkspaceFs,
  WorkspaceLease,
} from "@vidcom/adapter";
import {
  DEFAULT_VIDCOM_SETTINGS,
  ErrorCode,
  type ContentHash,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  MAX_CREDENTIAL_ROTATION_OVERLAP_MS,
  WriteAuthority,
  type ApprovalGrantRecord,
  type ProjectRef,
} from "@vidcom/core";
import {
  CliInputError,
  parseAppCommandArgs,
  parseMcpCommandArgs,
  parseVidcomCommand,
  runCliMain,
  runApproveCommand,
  runBackupCommand,
  runCredentialCommand,
  runMcpLifecycle,
  runRecoveryCommand,
  selectWorkspace,
  startVidcomMcp,
  waitForMcpShutdown,
} from "@vidcom/cli";
import type { AbsolutePath, ResolvedPath } from "@vidcom/core";
import { dbOne, dbRun } from "../support/database";

describe("VidCom CLI dispatch", () => {
  it("preserves bare/app invocation and recognizes every reviewed subcommand", () => {
    expect(parseVidcomCommand([])).toEqual({ name: "app", args: [] });
    expect(parseVidcomCommand(["--workspace", "/work"])).toEqual({
      name: "app",
      args: ["--workspace", "/work"],
    });
    for (const name of ["app", "mcp", "approve", "credential", "backup", "recovery"] as const) {
      expect(parseVidcomCommand([name, "argument"])).toEqual({ name, args: ["argument"] });
    }
  });

  it("strictly parses app options", () => {
    expect(parseAppCommandArgs(["--workspace", "/work", "--port", "43123"]))
      .toEqual({ workspace: "/work", port: 43123 });
    for (const args of [
      ["positional"],
      ["--unknown", "value"],
      ["--workspace"],
      ["--workspace", "one", "--workspace", "two"],
      ["--port", "0"],
      ["--port", "1.5"],
      ["--port", "65536"],
    ]) {
      expect(() => parseAppCommandArgs(args)).toThrow(CliInputError);
    }
  });

  it("writes dispatch errors only to stderr with input exit code 2", async () => {
    let stderr = "";
    const exitCode = await runCliMain(["unknown-command"], {
      stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
    });
    expect(exitCode).toBe(2);
    expect(stderr.trim()).toBe("unknown command: unknown-command");
  });

  it("maps unexpected command failures to exit code 1 without touching stdout", async () => {
    let stderr = "";
    const exitCode = await runCliMain([], {
      stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
    }, async () => { throw new Error("/private/workspace infrastructure\nfailed token=secret"); });
    expect(exitCode).toBe(1);
    expect(stderr).toBe("internal_error\n");
  });

  it("requires an explicit, saved or marker-backed workspace without creating a guess", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-missing-workspace-"));
    const cwd = path.join(root, "empty-cwd");
    await mkdir(cwd);
    try {
      await expect(selectWorkspace({
        appDataRoot: path.join(root, "app-data"),
        cwd,
      })).rejects.toThrow("workspace selection required");
      await expect(readFile(path.join(cwd, "hyperframes.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(cwd, "index.html"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed admin arguments before opening their persistence dependencies", async () => {
    await expect(runApproveCommand([])).rejects.toBeInstanceOf(CliInputError);
    await expect(runCredentialCommand(["list", "extra"])).rejects.toBeInstanceOf(CliInputError);
    await expect(runBackupCommand(["verify"])).rejects.toBeInstanceOf(CliInputError);
    await expect(runRecoveryCommand(["resolve", "1"])).rejects.toBeInstanceOf(CliInputError);
  });

  it.each([
    ["mcp", "--protocol", "2099-01-01"],
    ["approve"],
    ["credential", "unknown"],
    ["backup", "unknown"],
    ["recovery", "resolve", "1"],
  ])("returns exit 2 for invalid command arguments: %s", async (...argv) => {
    let stderr = "";
    await expect(runCliMain(argv, {
      stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
    })).resolves.toBe(2);
    expect(stderr).not.toBe("");
  });

  it("rejects a missing workspace without creating or guessing one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-missing-workspace-"));
    const cwd = path.join(root, "empty-cwd");
    const appData = path.join(root, "app-data");
    await mkdir(cwd);
    try {
      await expect(selectWorkspace({ appDataRoot: appData, cwd }))
        .rejects.toThrow("workspace selection required; pass --workspace or VIDCOM_WORKSPACE");
      await expect(readFile(path.join(cwd, "hyperframes.json"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(cwd, "index.html"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid explicit workspace without falling back or acquiring a lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-invalid-explicit-workspace-"));
    const active = path.join(root, "active");
    const project = path.join(active, "project");
    const invalid = path.join(root, "typo");
    const appData = path.join(root, "app-data");
    await mkdir(project, { recursive: true });
    await mkdir(invalid);
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    try {
      await expect(selectWorkspace({ explicit: active, appDataRoot: appData })).resolves.toBe(active);
      await expect(startVidcomMcp({ workspace: invalid }, {
        appDataRoot: () => appData,
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace,
        startStdio: async () => { throw new Error("listener must not open"); },
        writeError: () => { throw new Error("stderr must not be used"); },
      })).rejects.toBeInstanceOf(CliInputError);
      const database = await initializeDatabase(appData);
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await database.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strictly parses MCP workspace and exact protocol pin", () => {
    expect(parseMcpCommandArgs(["--workspace", "/work", "--protocol", "2026-07-28"]))
      .toEqual({ workspace: "/work", protocol: "2026-07-28" });
    expect(() => parseMcpCommandArgs(["--protocol", "2099-01-01"]))
      .toThrow(/supported: 2026-07-28, 2025-11-25/);
    expect(() => parseMcpCommandArgs(["--workspace", "/one", "--workspace", "/two"]))
      .toThrow(CliInputError);
    expect(() => parseMcpCommandArgs(["--unknown", "value"])).toThrow(CliInputError);
  });

  it("starts the full lease/startup graph and injects a credential-free stdio registry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-command-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    let stdioClosed = false;
    try {
      const runtime = await startVidcomMcp({ workspace, protocol: "2025-11-25" }, {
        appDataRoot: () => appData,
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace: async () => workspace as AbsolutePath,
        startStdio: async (registry, _dependencies, options) => {
          expect(options).toEqual({ pinnedRevision: "2025-11-25" });
          expect(registry.list("legacy").map((tool) => tool.name)).toHaveLength(13);
          return {
            close: async () => { stdioClosed = true; },
            closed: new Promise<void>(() => undefined),
          };
        },
        writeError: () => { throw new Error("unexpected stdio error"); },
      });
      await runtime.stop();
      expect(stdioClosed).toBe(true);
      const stoppedDatabase = await initializeDatabase(appData);
      expect(dbOne(stoppedDatabase, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await stoppedDatabase.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)("closes the MCP runtime once on %s", async (signal) => {
    const signals = new EventEmitter();
    const lifecycle: string[] = [];
    const stopped = waitForMcpShutdown({
      async stop() { lifecycle.push("transport-watcher-lease-db"); },
    }, signals);
    signals.emit(signal);
    signals.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    await stopped;
    expect(lifecycle).toEqual(["transport-watcher-lease-db"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("installs the signal gate before startup and absorbs repeated signals until cleanup settles", async () => {
    const signals = new EventEmitter();
    const lifecycle: string[] = [];
    let startupEntered!: () => void;
    const entered = new Promise<void>((resolve) => { startupEntered = resolve; });
    let continueStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => { continueStartup = resolve; });
    const running = runMcpLifecycle(async (signal) => {
      startupEntered();
      await startupGate;
      signal.throwIfAborted();
      throw new Error("startup should have aborted");
    }, signals).finally(() => { lifecycle.push("startup-unwound"); });

    await entered;
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    continueStartup();
    await running;
    expect(lifecycle).toEqual(["startup-unwound"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("keeps repeated-signal handlers installed until delayed cleanup settles", async () => {
    const signals = new EventEmitter();
    const lifecycle: string[] = [];
    let runtimeReady!: () => void;
    const ready = new Promise<void>((resolve) => { runtimeReady = resolve; });
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const running = runMcpLifecycle(async () => {
      runtimeReady();
      return {
        async stop() {
          lifecycle.push("cleanup-started");
          cleanupStarted();
          await cleanupGate;
          lifecycle.push("cleanup-settled");
        },
      };
    }, signals);
    await ready;
    signals.emit("SIGINT");
    await started;
    signals.emit("SIGTERM");
    expect(lifecycle).toEqual(["cleanup-started"]);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    finishCleanup();
    await running;
    expect(lifecycle).toEqual(["cleanup-started", "cleanup-settled"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("runs the same exhaustive cleanup when the stdio host disconnects", async () => {
    const signals = new EventEmitter();
    const lifecycle: string[] = [];
    let disconnect!: () => void;
    const stopped = waitForMcpShutdown({
      listener: { closed: new Promise<void>((resolve) => { disconnect = resolve; }) },
      async stop() { lifecycle.push("transport-watcher-lease-db"); },
    }, signals);
    disconnect();
    signals.emit("SIGTERM");
    await stopped;
    expect(lifecycle).toEqual(["transport-watcher-lease-db"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("releases the real workspace lease after a stdio host disconnect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-disconnect-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    const signals = new EventEmitter();
    let disconnect!: () => void;
    let listenerClosed = false;
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    try {
      const runtime = await startVidcomMcp({ workspace }, {
        appDataRoot: () => appData,
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace: async () => workspace as AbsolutePath,
        startStdio: async () => ({
          closed: new Promise<void>((resolve) => { disconnect = resolve; }),
          close: async () => { listenerClosed = true; },
        }),
        writeError: () => { throw new Error("unexpected stdio error"); },
      });
      const stopped = waitForMcpShutdown(runtime, signals);
      disconnect();
      await stopped;
      expect(listenerClosed).toBe(true);
      const database = await initializeDatabase(appData);
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await database.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("issues a trusted CLI approval in real SQLite and writes one JSON object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-approve-command-"));
    const appData = path.join(root, "app-data");
    const projectId = "project_approve_cli" as ProjectId;
    const now = "2026-08-02T00:00:00.000Z";
    const hash = `sha256:${"a".repeat(64)}` as ContentHash;
    const setup = await initializeDatabase(appData);
    dbRun(setup, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at)
      VALUES (?, '/workspace', 'project', ?, ?)`, projectId, now, now);
    const request: ApprovalGrantRecord = {
      id: "grant_cli_request",
      binding: {
        tool: "delete_file",
        projectId,
        target: "index.html",
        expectedRevision: 0,
        planDigest: hash,
        targetHashes: { ["index.html" as RelPath]: hash },
      },
      summary: "Delete index",
      status: "requested",
      approver: null,
      createdAt: now,
      expiresAt: "2026-08-02T00:10:00.000Z",
    };
    await new SqliteApprovalGrantStore(setup).create(request);
    await setup.destroy();
    let stdout = "";
    try {
      await runApproveCommand([request.id], {
        appDataRoot: () => appData,
        stdout: { write: (chunk) => { stdout += chunk; } },
        now: () => new Date(now),
      });
      expect(stdout).toBe(`${JSON.stringify({ grantId: request.id })}\n`);
      const verify = await initializeDatabase(appData);
      await expect(new SqliteApprovalGrantStore(verify).read(request.id)).resolves.toMatchObject({
        status: "issued",
        approver: "cli",
      });
      await verify.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs credential issue/list/rotate/revoke with one-time JSON secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-credential-command-"));
    const appData = path.join(root, "app-data");
    const now = "2026-08-02T00:00:00.000Z";
    let stdout = "";
    let id = 0;
    const dependencies = {
      appDataRoot: () => appData,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date(now),
      newId: () => `credential_cli_${++id}`,
    };
    try {
      await runCredentialCommand(["issue", "primary"], dependencies);
      const issued = JSON.parse(stdout.trim()) as { id: string; secret: string };
      expect(issued.id).toBe("credential_cli_1");
      expect(issued.secret).toMatch(/^vcmcp_[A-Za-z0-9_-]{43}$/);

      stdout = "";
      await runCredentialCommand(["list"], dependencies);
      const listed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(listed).toMatchObject({
        credentials: [{ id: issued.id, label: "primary", status: "active" }],
      });
      expect(stdout).not.toContain(issued.secret);
      expect(stdout).not.toContain("secretHash");
      expect(stdout).not.toContain("sha256:");

      stdout = "";
      await runCredentialCommand([
        "rotate", issued.id, "--overlap-ms", String(MAX_CREDENTIAL_ROTATION_OVERLAP_MS),
      ], dependencies);
      const rotated = JSON.parse(stdout.trim()) as { id: string; secret: string };
      expect(rotated.id).toBe("credential_cli_2");
      expect(rotated.secret).not.toBe(issued.secret);

      stdout = "";
      await runCredentialCommand(["revoke", rotated.id], dependencies);
      expect(JSON.parse(stdout.trim())).toEqual({ id: rotated.id, status: "revoked" });
      await expect(runCredentialCommand(["revoke", rotated.id], dependencies))
        .rejects.toMatchObject({ name: "CliInputError", message: "credential_invalid", exitCode: 2 });
      await expect(runCredentialCommand(["rotate", issued.id, "--overlap-ms", "0"], dependencies))
        .rejects.toBeInstanceOf(CliInputError);
      await expect(runCredentialCommand([
        "rotate", issued.id, "--overlap-ms", String(MAX_CREDENTIAL_ROTATION_OVERLAP_MS + 1),
      ], dependencies)).rejects.toMatchObject({
        name: "CliInputError",
        exitCode: 2,
      });

      stdout = "";
      await runCredentialCommand(["list"], dependencies);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        credentials: [
          { id: issued.id, status: "rotating", expiresAt: "2026-08-03T00:00:00.000Z" },
          { id: rotated.id, status: "revoked" },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists and verifies real app-data backups with strict JSON output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-backup-command-"));
    const appData = path.join(root, "app-data");
    const source = path.join(root, "index.html");
    const projectId = "project_backup_cli" as ProjectId;
    const now = "2026-08-02T00:00:00.000Z";
    await writeFile(source, "backup payload");
    const setup = await initializeDatabase(appData);
    dbRun(setup, `INSERT INTO project_registry
      (id, workspace_root, slug, first_seen_at, last_seen_at)
      VALUES (?, '/workspace', 'project', ?, ?)`, projectId, now, now);
    const backups = new AppDataBackupStore(
      appData,
      setup,
      { now: () => new Date(now) },
      { newId: () => "backup_cli" },
    );
    await backups.create(projectId, "tool:delete_file", [{
      path: "index.html" as RelPath,
      resolved: source as ResolvedPath,
    }]);
    await setup.destroy();

    let stdout = "";
    const dependencies = {
      appDataRoot: () => appData,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date(now),
      newId: () => "unused",
      selectWorkspace: async () => { throw new Error("read commands must not select a workspace"); },
    };
    try {
      await runBackupCommand(["list", projectId], dependencies);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        backups: [{ id: "backup_cli", projectId, reason: "tool:delete_file" }],
      });

      stdout = "";
      await runBackupCommand(["list"], dependencies);
      expect(JSON.parse(stdout.trim())).toMatchObject({ backups: [{ id: "backup_cli" }] });

      stdout = "";
      await runBackupCommand(["verify", "backup_cli"], dependencies);
      expect(JSON.parse(stdout.trim())).toEqual({ backupId: "backup_cli", valid: true });

      await writeFile(path.join(appData, "backups", projectId, "backup_cli", "payload", "index.html"), "tampered");
      stdout = "";
      await runBackupCommand(["verify", "backup_cli"], dependencies);
      expect(JSON.parse(stdout.trim())).toEqual({ backupId: "backup_cli", valid: false });
      await expect(runBackupCommand(["restore", "missing_backup"], dependencies))
        .rejects.toThrow("backup_not_found");
      const database = await initializeDatabase(appData);
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await database.destroy();
      await expect(runBackupCommand(["restore"], dependencies)).rejects.toBeInstanceOf(CliInputError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a real destructive backup through the Core use case", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-backup-restore-command-"));
    const appData = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    const projectId = "project_backup_restore_cli" as ProjectId;
    const now = "2026-08-02T00:00:00.000Z";
    const hash = (content: string | Uint8Array): ContentHash =>
      `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
    let nextId = 0;
    let stdout = "";
    const dependencies = {
      appDataRoot: () => appData,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date(now),
      newId: () => `cli_backup_id_${++nextId}`,
      selectWorkspace: async () => { throw new Error("restore must use the backup registration"); },
    };
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), "before destructive");

    try {
      const database = await initializeDatabase(appData);
      dbRun(database, `INSERT INTO project_registry
        (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
      projectId, workspaceRoot, now, now);
      const clock = { now: dependencies.now };
      const workspace = new WorkspaceFs(workspaceRoot as AbsolutePath);
      const journal = new MutationJournal(database, clock);
      const backups = new AppDataBackupStore(appData, database, clock, {
        newId: () => "backup_cli_destructive",
      });
      const lease = new WorkspaceLease(database, clock, {
        newId: () => `setup_id_${++nextId}`,
      });
      const acquired = await lease.acquire(workspaceRoot as AbsolutePath, "test:backup-cli");
      if (!acquired.ok) throw new Error("test lease was denied");
      const authority = new WriteAuthority({
        workspace,
        journal,
        compositeJournal: journal,
        lease,
        leaseId: acquired.leaseId,
        hashContent: hash,
        invalidate() {},
        notifyEvents() {},
        backups,
      });
      const ref: ProjectRef = {
        id: projectId,
        slug: "project",
        root: projectRoot as AbsolutePath,
        entry: "index.html" as RelPath,
      };
      const destructive = await authority.mutateComposite({
        ref,
        steps: [{
          kind: "write",
          path: "index.html" as RelPath,
          content: "after destructive",
          expectedContentHash: hash("before destructive"),
        }],
        toolAudit: {
          schemaVersion: 1,
          invocationId: "invocation-backup-cli",
          tool: "delete_scene",
          level: "destructive",
          projectId,
          era: "modern",
          protocolVersion: "2026-07-28",
          detail: {},
          credentialId: null,
          invokedAt: now,
          revisionBefore: 0,
        },
        backup: true,
      }, "agent");
      expect(destructive).toMatchObject({ ok: true });
      await lease.release(acquired.leaseId);
      await database.destroy();

      await runBackupCommand(["restore", "backup_cli_destructive"], dependencies);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        backupId: "backup_cli_destructive",
        envelope: { projectRevision: 2 },
      });
      expect(await readFile(path.join(projectRoot, "index.html"), "utf8"))
        .toBe("before destructive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inspects, deterministically reconciles and explicitly resolves real recovery journals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-recovery-command-"));
    const appData = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    const unrelatedWorkspace = path.join(root, "unrelated-workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    const projectId = "project_recovery_cli" as ProjectId;
    const now = "2026-08-02T00:00:00.000Z";
    const digest = (content: string): ContentHash =>
      `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
    let stdout = "";
    let nextId = 0;
    const dependencies = {
      appDataRoot: () => appData,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date(now),
      newId: (prefix: string) => `${prefix}_cli_${++nextId}`,
      selectWorkspace: async () => unrelatedWorkspace as AbsolutePath,
    };
    await mkdir(unrelatedWorkspace, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), "before");
    await writeFile(path.join(projectRoot, "orphan.html"), "ambiguous");

    try {
      const database = await initializeDatabase(appData);
      dbRun(database, `INSERT INTO project_registry
        (id, workspace_root, slug, first_seen_at, last_seen_at) VALUES (?, ?, 'project', ?, ?)`,
      projectId, workspaceRoot, now, now);
      const beginAuthority = { leaseId: "lease-recovery-cli" };
      dbRun(database, `INSERT INTO workspace_lease
        (workspace_root, lease_id, holder_id, acquired_at, expires_at)
        VALUES (?, ?, 'test', ?, '2026-08-02T01:00:00.000Z')`, workspaceRoot, beginAuthority.leaseId, now);
      const journal = new MutationJournal(database, { now: dependencies.now });
      const pending = await journal.beginComposite(
        { projectId, actor: "agent" },
        [{
          ordinal: 0,
          kind: "write",
          path: "index.html" as RelPath,
          entity: null,
          fromHash: digest("before"),
          toHash: digest("after"),
          previousContent: "before",
        }],
        { toolAudit: null },
        beginAuthority,
      );
      // Seed a legacy/multi-crash state without weakening the production T1 unresolved gate.
      dbRun(database, "UPDATE mutation_journal SET status = 'aborted' WHERE id = ?", pending);
      const orphan = await journal.beginComposite(
        { projectId, actor: "agent" },
        [{
          ordinal: 0,
          kind: "write",
          path: "orphan.html" as RelPath,
          entity: null,
          fromHash: digest("previous"),
          toHash: digest("intended"),
          previousContent: "previous",
        }],
        { toolAudit: null },
        beginAuthority,
      );
      await journal.orphanComposite(orphan, ErrorCode.RecoveryRequired);
      dbRun(database, "UPDATE mutation_journal SET status = 'pending' WHERE id = ?", pending);
      dbRun(database, "DELETE FROM workspace_lease WHERE lease_id = ?", beginAuthority.leaseId);
      await database.destroy();

      await runRecoveryCommand(["inspect", String(pending)], dependencies);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        journal: {
          id: pending,
          status: "pending",
          projectId,
          steps: [{ path: "index.html", fromHash: digest("before"), toHash: digest("after") }],
        },
      });
      const afterInspect = await initializeDatabase(appData);
      await expect(new MutationJournal(afterInspect, { now: dependencies.now }).readPendingComposite(pending))
        .resolves.toMatchObject({ status: "pending" });
      await afterInspect.destroy();

      stdout = "";
      await runRecoveryCommand(["reconcile", String(pending)], dependencies);
      expect(JSON.parse(stdout.trim())).toEqual({
        journalId: pending,
        outcome: { terminal: "aborted" },
      });

      await expect(runRecoveryCommand(["resolve", String(orphan)], dependencies))
        .rejects.toBeInstanceOf(CliInputError);
      await expect(runRecoveryCommand([
        "resolve", String(orphan), "--restore-previous", "--accept-current",
      ], dependencies)).rejects.toBeInstanceOf(CliInputError);
      stdout = "";
      await runRecoveryCommand(["resolve", String(orphan), "--restore-previous"], dependencies);
      expect(JSON.parse(stdout.trim())).toEqual({
        journalId: orphan,
        resolution: "restore-previous",
        envelope: null,
      });
      expect(await readFile(path.join(projectRoot, "orphan.html"), "utf8")).toBe("previous");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
