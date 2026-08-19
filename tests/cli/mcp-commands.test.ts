import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AppSettingsStore,
  AppDataBackupStore,
  initializeDatabase,
  migrateDatabase,
  MutationJournal,
  openVidcomDatabase,
  readPublishedRuntimeInstallation,
  RUNTIME_PATH_NAMES,
  SqliteApprovalGrantStore,
  SqliteJobStore,
  WorkspaceFs,
  WorkspaceLease,
  type DaemonClient,
  type RuntimePaths,
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
import type { ToolInvoker } from "@vidcom/mcp";
import {
  BRIDGE_CREDENTIAL_SETTING,
  CliInputError,
  createInfrastructure,
  defaultAppDataRoot,
  type BackupCommandDependencies,
  parseAppCommandArgs,
  parseMcpCommandArgs,
  parseVidcomCommand,
  prepareRuntimeForCli,
  runCliMain,
  runApproveCommand,
  runBackupCommand,
  runCredentialCommand,
  runMcpLifecycle,
  runRecoveryCommand,
  renderWorkspaceRoot,
  runtimePathsFor,
  selectWorkspace,
  startVidcomMcp,
  type McpBridgeConnection,
  waitForMcpShutdown,
} from "@vidcom/cli";
import type { AbsolutePath, JobId, ResolvedPath } from "@vidcom/core";
import { earlyAppDataRoot } from "../../packages/cli/src/app-data-root";
import { configureCompilerBeforeRuntime } from "../../packages/cli/src/compiler-preload";
import { dbOne, dbRun } from "../support/database";
import {
  archiveFor,
  assetSource,
  HOST_SUPPORTED,
  HOST_TAG,
  productRuntimeFixtureEntries,
  runtimeManifest,
} from "../support/runtime-fixture";

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
const MIGRATIONS_SOURCE = new URL("../../packages/adapter/drizzle/", import.meta.url);
const SHIPPED_MIGRATIONS = readdirSync(MIGRATIONS_SOURCE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()
    && existsSync(new URL(`${entry.name}/migration.sql`, MIGRATIONS_SOURCE)))
  .sort((left, right) => left.name.localeCompare(right.name, "en"))
  .map((entry) => ({
    path: path.posix.join("drizzle", entry.name, "migration.sql"),
    content: readFileSync(new URL(`${entry.name}/migration.sql`, MIGRATIONS_SOURCE)),
  }));

function mcpBridgeConnection(overrides: Partial<DaemonClient> = {}): McpBridgeConnection {
  const client: DaemonClient = {
    handshake: () => Promise.reject(new Error("unused")),
    attach: () => Promise.reject(new Error("unused")),
    renew: () => Promise.resolve({
      attachmentId: "attachment-mcp",
      heartbeatEveryMs: 5_000,
      expiresAt: "2026-08-12T00:00:20.000Z",
    }),
    detach: () => Promise.resolve(),
    invokeTool: () => Promise.resolve({ projects: [] }),
    enqueueRender: () => Promise.reject(new Error("unused")),
    getJob: () => Promise.reject(new Error("unused")),
    cancelJob: () => Promise.reject(new Error("unused")),
    ...overrides,
  };
  return { client, attachmentId: "attachment-mcp", heartbeatEveryMs: 5_000 };
}

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
    // J.1 requires the message to name the valid modes: the answer is a short
    // fixed set, and making the user search for it is the least useful thing a
    // CLI can do.
    expect(stderr.trim()).toBe(
      "unknown command: unknown-command."
      + " Available: app, serve, mcp, render, doctor, version, approve, credential, backup, recovery",
    );
  });

  it("maps unexpected command failures to exit code 1 without touching stdout", async () => {
    let stderr = "";
    const exitCode = await runCliMain([], {
      stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
    }, async () => { throw new Error("/private/workspace infrastructure\nfailed token=secret"); });
    expect(exitCode).toBe(1);
    expect(stderr).toBe("internal_error\n");
  });

  it("uses a readable cwd as the workspace without creating project files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-missing-workspace-"));
    const cwd = path.join(root, "empty-cwd");
    await mkdir(cwd);
    const database = await initializeDatabase(path.join(root, "app-data"));
    try {
      await expect(selectWorkspace({
        appDataRoot: path.join(root, "app-data"),
        cwd,
        database,
      })).resolves.toBe(await realpath(cwd));
      await expect(readFile(path.join(cwd, "hyperframes.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(cwd, "index.html"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await database.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses one physical workspace identity for real and aliased paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-workspace-alias-"));
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    const appData = path.join(root, "app-data");
    await mkdir(workspace);
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const physicalRoot = await realpath(workspace);
    const database = await initializeDatabase(appData);
    try {
      const selectedReal = await selectWorkspace({ explicit: workspace, appDataRoot: appData, database });
      const selectedAlias = await selectWorkspace({ explicit: alias, appDataRoot: appData, database });
      expect(selectedReal).toBe(physicalRoot);
      expect(selectedAlias).toBe(physicalRoot);
      await expect(renderWorkspaceRoot(["project", "--workspace", alias])).resolves.toBe(physicalRoot);

      const lease = new WorkspaceLease(database, { now: () => new Date("2026-08-12T00:00:00.000Z") }, {
        newId: () => "lease_workspace_alias",
      });
      const acquired = await lease.acquire(selectedReal, "holder-real");
      expect(acquired.ok).toBe(true);
      const viaAlias = await lease.acquire(selectedAlias, "holder-alias");
      expect(viaAlias.ok).toBe(false);
    } finally {
      await database.destroy();
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

  it("persists a readable empty cwd without creating or guessing project files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-missing-workspace-"));
    const cwd = path.join(root, "empty-cwd");
    const appData = path.join(root, "app-data");
    await mkdir(cwd);
    const database = await initializeDatabase(appData);
    try {
      await expect(selectWorkspace({ appDataRoot: appData, cwd, database }))
        .resolves.toBe(await realpath(cwd));
      await expect(readFile(path.join(cwd, "hyperframes.json"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(cwd, "index.html"), "utf8")).rejects.toThrow();
    } finally {
      await database.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing explicit workspace without falling back or acquiring a lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-invalid-explicit-workspace-"));
    const active = path.join(root, "active");
    const project = path.join(active, "project");
    const invalid = path.join(root, "typo");
    const appData = path.join(root, "app-data");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "vidcom.json"), '{"id":"project_explicit_active"}\n');
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    const database = await initializeDatabase(appData);
    try {
      await expect(selectWorkspace({ explicit: active, appDataRoot: appData, database }))
        .resolves.toBe(await realpath(active));
      await expect(startVidcomMcp({ workspace: invalid }, {
        appDataRoot: () => appData,
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace: async () => { throw new Error("explicit workspace must not open SQLite"); },
        canonicalizeWorkspace: realpath,
        openWorkspaceDatabase: () => { throw new Error("explicit workspace must not open SQLite"); },
        connectBridge: async () => { throw new Error("bridge must not connect"); },
        startStdio: async () => { throw new Error("listener must not open"); },
        writeError: () => { throw new Error("stderr must not be used"); },
      })).rejects.toBeInstanceOf(CliInputError);
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
    } finally {
      await database.destroy();
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

  it("publishes the full catalogue through a remote invoker without acquiring a lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-command-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "vidcom.json"), '{"id":"project_mcp_command"}\n');
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    let stdioClosed = false;
    let detached = false;
    try {
      const runtime = await startVidcomMcp({ workspace, protocol: "2025-11-25" }, {
        appDataRoot: () => appData,
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace: async () => { throw new Error("explicit workspace must not open SQLite"); },
        canonicalizeWorkspace: async (root) => root,
        openWorkspaceDatabase: () => { throw new Error("explicit workspace must not read app-data SQLite"); },
        connectBridge: async () => mcpBridgeConnection({
          detach: async () => { detached = true; },
        }),
        startStdio: async (registry, _dependencies, options) => {
          expect(options?.pinnedRevision).toBe("2025-11-25");
          expect(options?.invoker).toBeDefined();
          expect(registry.list("legacy").map((tool) => tool.name)).toHaveLength(41);
          await expect(options?.invoker?.invoke("list_projects", {}, {
            era: "legacy",
            protocolVersion: "2025-11-25",
            credentialId: null,
            requestInput: () => Promise.reject(new Error("unused")),
          })).resolves.toMatchObject({ ok: true, value: { projects: [] } });
          return {
            close: async () => { stdioClosed = true; },
            closed: new Promise<void>(() => undefined),
          };
        },
        writeError: () => { throw new Error("unexpected stdio error"); },
      });
      const runningDatabase = await initializeDatabase(appData);
      expect(dbOne(runningDatabase, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await runningDatabase.destroy();
      await runtime.stop();
      expect(stdioClosed).toBe(true);
      expect(detached).toBe(true);
      const stoppedDatabase = await initializeDatabase(appData);
      expect(dbOne(stoppedDatabase, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await stoppedDatabase.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads active_workspace from existing SQLite without runtime bootstrap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-active-workspace-"));
    const workspace = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    await mkdir(workspace, { recursive: true });
    const setup = await initializeDatabase(appData);
    new AppSettingsStore(setup).set("active_workspace", await realpath(workspace));
    await setup.destroy();
    let connectedWorkspace: string | undefined;
    try {
      const runtime = await startVidcomMcp({}, {
        appDataRoot: () => appData,
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace,
        canonicalizeWorkspace: realpath,
        openWorkspaceDatabase: openVidcomDatabase,
        connectBridge: async ({ workspaceRoot }) => {
          connectedWorkspace = workspaceRoot;
          return mcpBridgeConnection();
        },
        startStdio: async () => ({
          close: () => Promise.resolve(),
          closed: new Promise<void>(() => undefined),
        }),
        writeError: () => { throw new Error("unexpected stdio error"); },
      });
      expect(connectedWorkspace).toBe(await realpath(workspace));
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reattaches after heartbeat failure and routes later tools to the replacement daemon", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-reconnect-"));
    let connections = 0;
    let replacementReady!: () => void;
    const reconnected = new Promise<void>((resolve) => { replacementReady = resolve; });
    let invoker: ToolInvoker | undefined;
    try {
      const runtime = await startVidcomMcp({ workspace }, {
        appDataRoot: () => path.join(workspace, "app-data"),
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace: async () => workspace as AbsolutePath,
        canonicalizeWorkspace: async (root) => root,
        openWorkspaceDatabase: () => { throw new Error("explicit workspace must not open SQLite"); },
        connectBridge: async () => {
          connections += 1;
          if (connections === 1) {
            return {
              ...mcpBridgeConnection({ renew: () => Promise.reject(new Error("daemon restarted")) }),
              heartbeatEveryMs: 1,
            };
          }
          replacementReady();
          return {
            ...mcpBridgeConnection({ invokeTool: () => Promise.resolve({ daemon: "replacement" }) }),
            heartbeatEveryMs: 60_000,
          };
        },
        startStdio: async (_registry, _dependencies, options) => {
          invoker = options?.invoker;
          return {
            close: () => Promise.resolve(),
            closed: new Promise<void>(() => undefined),
          };
        },
        writeError: () => { throw new Error("successful reconnect must stay quiet"); },
      });
      // Use the shortest policy only for the first attachment so the production
      // maintenance loop is exercised without sleeping for five seconds here.
      await reconnected;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!invoker) throw new Error("stdio did not receive its remote invoker");
      await expect(invoker.invoke("list_projects", {}, {
        era: "modern",
        protocolVersion: "2026-07-28",
        credentialId: null,
        requestInput: () => Promise.reject(new Error("unused")),
      })).resolves.toMatchObject({ ok: true, value: { daemon: "replacement" } });
      await runtime.stop();
      expect(connections).toBe(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
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

  it("leaves the daemon-owned lease and queued work intact after stdio disconnect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-disconnect-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    const signals = new EventEmitter();
    let disconnect!: () => void;
    let listenerClosed = false;
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "vidcom.json"), '{"id":"project_mcp_disconnect"}\n');
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    try {
      const daemonDatabase = await initializeDatabase(appData);
      const clock = { now: () => new Date("2026-08-12T00:00:00.000Z") };
      const daemonLease = new WorkspaceLease(daemonDatabase, clock, {
        newId: () => "lease_daemon_ui",
      });
      await expect(daemonLease.acquire(workspace as AbsolutePath, "ui:daemon"))
        .resolves.toMatchObject({ ok: true });
      const jobs = new SqliteJobStore(daemonDatabase, clock);
      await jobs.enqueue({
        id: "job_survives_stdio_disconnect" as JobId,
        projectId: null,
        type: "snapshot",
        input: { projectId: "project_mcp_disconnect" },
        inputHash: `sha256:${"a".repeat(64)}` as ContentHash,
        idempotencyKey: null,
      });
      await daemonDatabase.destroy();

      const runtime = await startVidcomMcp({ workspace }, {
        appDataRoot: () => appData,
        readSettings: async () => DEFAULT_VIDCOM_SETTINGS,
        selectWorkspace: async () => workspace as AbsolutePath,
        canonicalizeWorkspace: async (root) => root,
        openWorkspaceDatabase: () => { throw new Error("explicit workspace must not open SQLite"); },
        connectBridge: async () => mcpBridgeConnection(),
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
        .toEqual({ count: 1 });
      expect(dbOne(database, "SELECT status FROM job WHERE id = ?", "job_survives_stdio_disconnect"))
        .toEqual({ status: "queued" });
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
    const settingsPath = path.join(root, "setting.json");
    const now = "2026-08-02T00:00:00.000Z";
    let stdout = "";
    let id = 0;
    const dependencies = {
      appDataRoot: defaultAppDataRoot,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date(now),
      newId: () => `credential_cli_${++id}`,
    };
    await writeFile(settingsPath, JSON.stringify({ appDataRoot: appData }));
    const previousAppData = process.env.VIDCOM_APP_DATA;
    const previousSettings = process.env.VIDCOM_SETTINGS;
    try {
      delete process.env.VIDCOM_APP_DATA;
      process.env.VIDCOM_SETTINGS = settingsPath;
      await configureCompilerBeforeRuntime();
      expect(process.env.VIDCOM_APP_DATA).toBe(appData);

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
      if (previousAppData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = previousAppData;
      if (previousSettings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = previousSettings;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses generic rotate and revoke for the system bridge credential", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-credential-bridge-guard-"));
    const appData = path.join(root, "app-data");
    let stdout = "";
    let id = 0;
    const dependencies = {
      appDataRoot: () => appData,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      newId: () => `credential_bridge_guard_${++id}`,
    };
    try {
      await runCredentialCommand(["issue", "system:bridge"], dependencies);
      const issued = JSON.parse(stdout.trim()) as { id: string };
      const setup = await initializeDatabase(appData);
      new AppSettingsStore(setup, dependencies.now).set(BRIDGE_CREDENTIAL_SETTING, issued.id);
      await setup.destroy();

      await expect(runCredentialCommand(["rotate", issued.id], dependencies)).rejects.toMatchObject({
        name: "CliInputError",
        message: "the system bridge credential cannot be rotated by the generic credential command",
      });
      await expect(runCredentialCommand(["revoke", issued.id], dependencies)).rejects.toMatchObject({
        name: "CliInputError",
        message: "the system bridge credential cannot be revoked by the generic credential command",
      });

      stdout = "";
      await runCredentialCommand(["list"], dependencies);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        credentials: [{ id: issued.id, status: "active" }],
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
    let prepareCalls = 0;
    const dependencies = {
      appDataRoot: () => appData,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date(now),
      newId: () => "unused",
      prepareRuntime: (root: string) => {
        prepareCalls += 1;
        return prepareRuntimeForCli(root);
      },
      runtimePathsFor,
      createInfrastructure,
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
      expect(prepareCalls).toBe(0);
      await expect(runBackupCommand(["restore", "missing_backup"], dependencies))
        .rejects.toThrow("backup_not_found");
      expect(prepareCalls).toBe(1);
      const database = await initializeDatabase(appData);
      expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await database.destroy();
      await expect(runBackupCommand(["restore"], dependencies)).rejects.toBeInstanceOf(CliInputError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!HOST_SUPPORTED)("prepares an artifact runtime once before restoring a real destructive backup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-backup-restore-command-"));
    const appData = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    const settingsPath = path.join(root, "setting.json");
    const projectId = "project_backup_restore_cli" as ProjectId;
    const now = "2026-08-02T00:00:00.000Z";
    const hash = (content: string | Uint8Array): ContentHash =>
      `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
    let nextId = 0;
    let stdout = "";
    const product = productRuntimeFixtureEntries(SHIPPED_MIGRATIONS);
    const nodeArchive = archiveFor(
      "node",
      [
        { path: "cli/boot.cjs", content: Buffer.from("module.exports = {};\n") },
        { path: "runtime.txt", content: Buffer.from("backup runtime\n") },
        ...product.node,
        ...product.native,
      ],
      HOST_TAG,
      "node-runtime",
    );
    const hyperframesArchive = archiveFor(
      "hyperframes",
      [
        ...product.hyperframes,
        ...product.native,
      ],
      HOST_TAG,
      "hyperframes-runtime",
    );
    const bgmArchive = archiveFor(
      "bgm",
      [
        "alex-morgan-corporate-business-background.mp3",
        "corporate-marimba-business-background.mp3",
        "meta.mp3",
        "promo-promo-business-background.mp3",
      ].map((filename) => ({ path: filename, content: Buffer.from(`bgm:${filename}\n`) })),
      HOST_TAG,
      "bgm-runtime",
    );
    const runtimeAssets = assetSource(
      runtimeManifest("1.0.0", [bgmArchive.archive, nodeArchive.archive, hyperframesArchive.archive]),
      { bgm: bgmArchive.bytes, node: nodeArchive.bytes, hyperframes: hyperframesArchive.bytes },
    );
    let migrationCalls = 0;
    let infrastructureCalls = 0;
    let observedPrepareRoot: string | undefined;
    let observedInfrastructureRoot: string | undefined;
    let observedRuntimePaths: RuntimePaths | undefined;
    const countedMigration: typeof migrateDatabase = async (database, migrationsFolder) => {
      migrationCalls += 1;
      await migrateDatabase(database, migrationsFolder);
    };
    const dependencies: BackupCommandDependencies = {
      appDataRoot: earlyAppDataRoot,
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      now: () => new Date(now),
      newId: () => `cli_backup_id_${++nextId}`,
      prepareRuntime: (preparedRoot) => {
        observedPrepareRoot = preparedRoot;
        return prepareRuntimeForCli(preparedRoot, {
          assetSource: runtimeAssets,
          migrate: countedMigration,
        });
      },
      runtimePathsFor: (root, prepared) => runtimePathsFor(root, prepared),
      createInfrastructure: (config) => {
        infrastructureCalls += 1;
        observedInfrastructureRoot = config.appDataRoot;
        observedRuntimePaths = config.runtimePaths;
        return createInfrastructure(config);
      },
    };
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), "before destructive");
    await writeFile(settingsPath, JSON.stringify({ appDataRoot: appData }));
    const previousAppData = process.env.VIDCOM_APP_DATA;
    const previousSettings = process.env.VIDCOM_SETTINGS;
    delete process.env.VIDCOM_APP_DATA;
    process.env.VIDCOM_SETTINGS = settingsPath;

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
      const destructive = await authority.mutateSource({
        ref,
        steps: [{
          kind: "write",
          path: "index.html" as RelPath,
          content: "after destructive",
          expectedContentHash: hash("before destructive"),
        }],
        origin: TEST_ORIGIN,
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
      expect(migrationCalls).toBe(1);
      expect(infrastructureCalls).toBe(1);
      expect(observedPrepareRoot).toBe(appData);
      expect(observedInfrastructureRoot).toBe(appData);
      expect(observedRuntimePaths?.mode).toBe("artifact");
      for (const name of RUNTIME_PATH_NAMES) {
        expect(path.isAbsolute(observedRuntimePaths?.[name] ?? ""), name).toBe(true);
      }
      const canonicalAppData = await realpath(appData);
      expect(observedRuntimePaths?.nativeDependenciesRoot).toBe(path.join(
        canonicalAppData,
        "native",
        "1.0.0",
        "node-runtime",
      ));
      expect(observedRuntimePaths?.hyperframesPackagePath).toBe(path.join(
        canonicalAppData,
        "native",
        "1.0.0",
        "hyperframes-runtime",
        "package.json",
      ));
      if (!observedRuntimePaths) throw new Error("restore did not receive runtime paths");
      expect(await readFile(observedRuntimePaths.hyperframesPackagePath, "utf8"))
        .toContain('"version":"0.7.86"');

      let incompleteMigrationCalls = 0;
      let incompleteInfrastructureCalls = 0;
      const incompleteDependencies: BackupCommandDependencies = {
        ...dependencies,
        prepareRuntime: (root) => prepareRuntimeForCli(root, {
          assetSource: assetSource(runtimeManifest("1.0.1", [nodeArchive.archive]), {
            node: nodeArchive.bytes,
          }),
          migrate: async (database, migrationsFolder) => {
            incompleteMigrationCalls += 1;
            await migrateDatabase(database, migrationsFolder);
          },
        }),
        createInfrastructure: (config) => {
          incompleteInfrastructureCalls += 1;
          return createInfrastructure(config);
        },
      };
      await expect(runBackupCommand(["restore", "backup_cli_destructive"], incompleteDependencies))
        .rejects.toMatchObject({ code: ErrorCode.RuntimeManifestInvalid });
      // `hyperframes` exists in this source checkout. A fallback to
      // require.resolve/PATH would make this pass; artifact mode must stop before
      // the composition root or workspace lease instead.
      expect(incompleteMigrationCalls).toBe(0);
      expect(incompleteInfrastructureCalls).toBe(0);
      const published = await readPublishedRuntimeInstallation(appData);
      expect(published?.manifest.artifactVersion).toBe("1.0.0");
      expect(published?.archiveRoots).toMatchObject({
        node: path.join(appData, "native", "1.0.0", "node-runtime"),
        hyperframes: path.join(appData, "native", "1.0.0", "hyperframes-runtime"),
      });
      expect(existsSync(path.join(appData, "native", "1.0.1"))).toBe(false);
      const verification = await initializeDatabase(appData);
      expect(dbOne(verification, "SELECT COUNT(*) AS count FROM workspace_lease"))
        .toEqual({ count: 0 });
      await verification.destroy();
    } finally {
      if (previousAppData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = previousAppData;
      if (previousSettings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = previousSettings;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inspects, deterministically reconciles and explicitly resolves real recovery journals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-recovery-command-"));
    const appData = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    const unrelatedWorkspace = path.join(root, "unrelated-workspace");
    const projectRoot = path.join(workspaceRoot, "project");
    const settingsPath = path.join(root, "setting.json");
    const projectId = "project_recovery_cli" as ProjectId;
    const now = "2026-08-02T00:00:00.000Z";
    const digest = (content: string): ContentHash =>
      `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
    let stdout = "";
    let nextId = 0;
    let appDataRootCalls = 0;
    const dependencies = {
      appDataRoot: async () => {
        appDataRootCalls += 1;
        return earlyAppDataRoot();
      },
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
    await writeFile(settingsPath, JSON.stringify({ appDataRoot: appData }));
    const previousAppData = process.env.VIDCOM_APP_DATA;
    const previousSettings = process.env.VIDCOM_SETTINGS;
    delete process.env.VIDCOM_APP_DATA;
    process.env.VIDCOM_SETTINGS = settingsPath;

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
      // Invalid syntax stops before settings I/O; every executable command
      // resolves the settings-aware root exactly once.
      expect(appDataRootCalls).toBe(3);
    } finally {
      if (previousAppData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = previousAppData;
      if (previousSettings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = previousSettings;
      await rm(root, { recursive: true, force: true });
    }
  });

});
