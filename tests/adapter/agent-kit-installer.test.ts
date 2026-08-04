import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_KIT_FILES, AGENT_KIT_VERSION } from "@vidcom/agent-kit";
import {
  InstallAgentKitInputSchema,
  type ContentHash,
} from "@vidcom/contracts";
import {
  AgentKitInstaller,
  ToolAuditService,
  WorkspaceMutationCoordinator,
  type AbsolutePath,
  type ClockPort,
  type WorkspacePort,
} from "@vidcom/core";
import {
  initializeDatabase,
  LargePreviousContentStore,
  SqliteToolAuditRepository,
  WorkspaceFs,
  WorkspaceLease,
  WorkspaceOperationJournal,
} from "@vidcom/adapter";
import { installAgentKitTool, ToolRegistry } from "@vidcom/mcp";

import { dbAll, dbOne } from "../support/database";
import { createSequentialIdPort } from "../support/deterministic";

const clock: ClockPort = { now: () => new Date("2026-08-04T00:00:00.000Z") };
const hash = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
const bundle = {
  version: AGENT_KIT_VERSION,
  files: AGENT_KIT_FILES as unknown as Record<string, { content: string; contentHash: ContentHash }>,
};

let root: string;
let workspaceRoot: AbsolutePath;
let workspace: WorkspaceFs;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
let journal: WorkspaceOperationJournal;
let lease: WorkspaceLease;
let leaseId: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-agent-kit-"));
  workspaceRoot = path.join(root, "workspace") as AbsolutePath;
  await mkdir(workspaceRoot, { recursive: true });
  const appData = path.join(root, "app-data");
  database = await initializeDatabase(appData);
  workspace = new WorkspaceFs(workspaceRoot);
  journal = new WorkspaceOperationJournal(database, clock, new LargePreviousContentStore(appData));
  lease = new WorkspaceLease(database, clock, createSequentialIdPort());
  const acquired = await lease.acquire(workspaceRoot, "test:agent-kit");
  if (!acquired.ok) throw new Error("workspace lease denied");
  leaseId = acquired.leaseId;
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

function createInstaller(workspacePort: WorkspacePort = workspace): AgentKitInstaller {
  const coordinator = new WorkspaceMutationCoordinator({
    workspace: workspacePort,
    journal,
    lease,
    leaseId,
    hashContent: hash,
  });
  return new AgentKitInstaller({
    workspace: workspacePort,
    bundle,
    actor: "agent",
    authority: { mutateWorkspace: coordinator.mutate.bind(coordinator) },
  });
}

async function put(relativePath: string, content: string): Promise<void> {
  const target = path.join(workspaceRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function source(name: string): string {
  const file = bundle.files[name];
  if (!file) throw new Error(`missing bundle source ${name}`);
  return file.content;
}

describe("AgentKitInstaller with real SQLite and filesystem", () => {
  it("persists MCP protocol audit for applied and audited no-change installs", async () => {
    const audit = new ToolAuditService(
      new SqliteToolAuditRepository(database),
      clock,
      { warn: () => undefined, error: () => undefined },
      { increment: () => undefined, observeMilliseconds: () => undefined },
      { isJournalOwned: journal.isJournalOwned.bind(journal) },
    );
    const registry = new ToolRegistry({
      audit,
      approvals: { request: async () => "unused" },
    }, {
      newInvocationId: (() => {
        let sequence = 0;
        return () => `agent-kit-invocation-${++sequence}`;
      })(),
      now: () => clock.now(),
    });
    registry.register(installAgentKitTool({
      workspaceRoot,
      agentKit: createInstaller(),
    } as unknown as Parameters<typeof installAgentKitTool>[0]));
    const request = {
      era: "modern" as const,
      protocolVersion: "2026-07-28",
      credentialId: "credential-agent-kit",
      requestInput: async (): Promise<never> => { throw new Error("input not expected"); },
    };

    await expect(registry.invoke("install_agent_kit", {
      operation: "install",
      hosts: ["codex"],
    }, request)).resolves.toMatchObject({
      ok: true,
      value: { operationResult: { status: "applied" } },
    });
    await expect(registry.invoke("install_agent_kit", {
      operation: "install",
      hosts: ["codex"],
    }, request)).resolves.toMatchObject({
      ok: true,
      value: { operationResult: { status: "no_change" } },
    });

    expect(dbAll(database, `
      SELECT action, actor, protocol_version AS protocolVersion, project_id AS projectId
      FROM audit_entry ORDER BY id
    `)).toEqual([
      { action: "tool:install_agent_kit", actor: "agent", protocolVersion: "2026-07-28", projectId: null },
      { action: "tool:install_agent_kit", actor: "agent", protocolVersion: "2026-07-28", projectId: null },
    ]);
    expect(dbAll(database, `
      SELECT workspace_operation.id, COUNT(workspace_operation_step.ordinal) AS steps
      FROM workspace_operation
      LEFT JOIN workspace_operation_step ON workspace_operation_step.operation_id = workspace_operation.id
      GROUP BY workspace_operation.id ORDER BY workspace_operation.id
    `)).toEqual([{ id: 1, steps: 15 }, { id: 2, steps: 0 }]);
  });

  it("installs only the selected host, then reports already_installed without another write", async () => {
    await put("AGENTS.md", source("AGENTS.md"));
    const first = await createInstaller().apply(workspaceRoot, { operation: "install", hosts: ["codex"] });
    expect(first).toMatchObject({
      ok: true,
      value: {
        operationResult: { status: "applied" },
        installationState: { outcome: "installed", usableBy: { codex: "ready" } },
      },
    });
    if (!first.ok) throw new Error("install failed");
    expect(first.value.installationState.files.every((file) => file.host === "codex")).toBe(true);
    await expect(readFile(path.join(workspaceRoot, "CLAUDE.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const second = await createInstaller().apply(workspaceRoot, { operation: "install", hosts: ["codex"] });
    expect(second).toMatchObject({
      ok: true,
      value: {
        operationResult: { status: "no_change", changedFiles: [] },
        installationState: { outcome: "already_installed", usableBy: { codex: "ready" } },
      },
    });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM event_outbox")).toEqual({ count: 0 });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM backup_manifest")).toEqual({ count: 0 });
    expect(dbAll(database, "SELECT project_id AS projectId, action FROM audit_entry"))
      .toEqual([{ projectId: null, action: "agent-kit.install" }]);
  });

  it("classifies all six per-file states and never downgrades newer content", async () => {
    const entries = [
      ["AGENTS.md", `${source("AGENTS.md")}\nmodified`],
      [".agents/skills/vidcom/SKILL.md", source("skills/vidcom/SKILL.md")],
      [".agents/skills/vidcom-project/SKILL.md", source("skills/vidcom-project/SKILL.md").replace("x-vidcom-agent-kit: 1", "x-vidcom-agent-kit: 0")],
      [".agents/skills/vidcom-scene/SKILL.md", source("skills/vidcom-scene/SKILL.md").replace("x-vidcom-agent-kit: 1", "x-vidcom-agent-kit: 2")],
      [".agents/skills/vidcom-look/SKILL.md", "user owned skill"],
      [".agents/skills/vidcom-render/SKILL.md", source("skills/vidcom-render/SKILL.md")],
      [".agents/skills/vidcom-fix/SKILL.md", source("skills/vidcom-fix/SKILL.md")],
    ] as const;
    for (const [target, content] of entries) await put(target, content);
    const result = await createInstaller().apply(workspaceRoot, {
      operation: "replace",
      host: "codex",
      relativePath: ".agents/skills/vidcom-render/SKILL.md",
      expectedContentHash: hash(source("skills/vidcom-render/SKILL.md")),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const states = Object.fromEntries(result.value.installationState.files.map((file) => [file.relativePath, file.state]));
    expect(new Set(Object.values(states))).toEqual(new Set([
      "missing", "current_pristine", "current_modified", "outdated", "newer", "foreign",
    ]));
    expect(states[".agents/skills/vidcom-scene/SKILL.md"]).toBe("newer");
    expect(await readFile(path.join(workspaceRoot, ".agents/skills/vidcom-scene/SKILL.md"), "utf8"))
      .toContain("x-vidcom-agent-kit: 2");
  });

  it("reports two discoverable but incomplete hosts as partial, not blocked", async () => {
    await put("AGENTS.md", "user codex instructions");
    await put("CLAUDE.md", "user claude instructions");
    const result = await createInstaller().apply(workspaceRoot, { operation: "install", hosts: ["codex", "claude-code"] });
    expect(result).toMatchObject({
      ok: true,
      value: { installationState: { outcome: "partial", usableBy: { codex: "degraded", "claude-code": "degraded" } } },
    });
    if (!result.ok) throw new Error("install failed");
    expect(result.value.installationState.recovery.find((item) => item.host === "codex")?.detail)
      .toContain(path.join(workspaceRoot, "AGENTS.vidcom.md"));
    expect(await readFile(path.join(workspaceRoot, "AGENTS.vidcom.md"), "utf8")).toBe(source("AGENTS.md"));
    expect(await readFile(path.join(workspaceRoot, "CLAUDE.vidcom.md"), "utf8")).toBe(source("CLAUDE.md"));
  });

  it("uses native router discovery: marker-only main is degraded while an unparseable router is blocked", async () => {
    await put("AGENTS.md", "<!-- x-vidcom-agent-kit: 1 -->\n");
    for (const name of ["vidcom", "vidcom-project", "vidcom-scene", "vidcom-look", "vidcom-narration", "vidcom-render", "vidcom-fix"] as const) {
      await put(`.agents/skills/${name}/SKILL.md`, source(`skills/${name}/SKILL.md`));
    }
    const degraded = await createInstaller().apply(workspaceRoot, {
      operation: "replace",
      host: "codex",
      relativePath: ".agents/skills/vidcom-project/SKILL.md",
      expectedContentHash: hash(source("skills/vidcom-project/SKILL.md")),
    });
    expect(degraded).toMatchObject({ ok: true, value: { installationState: { usableBy: { codex: "degraded" } } } });
    await put(".agents/skills/vidcom/SKILL.md", "---\nx-vidcom-agent-kit: 1\n---\nmissing name");
    const blocked = await createInstaller().apply(workspaceRoot, {
      operation: "replace",
      host: "codex",
      relativePath: ".agents/skills/vidcom-project/SKILL.md",
      expectedContentHash: hash(source("skills/vidcom-project/SKILL.md")),
    });
    expect(blocked).toMatchObject({ ok: true, value: { installationState: { outcome: "blocked", usableBy: { codex: "blocked" } } } });
  });

  it("links only Claude and upgrades its effective instruction chain to ready", async () => {
    await put("CLAUDE.md", "user instructions\n");
    const installed = await createInstaller().apply(workspaceRoot, { operation: "install", hosts: ["claude-code"] });
    expect(installed).toMatchObject({ ok: true, value: { installationState: { usableBy: { "claude-code": "degraded" } } } });
    const linked = await createInstaller().apply(workspaceRoot, {
      operation: "link",
      host: "claude-code",
      expectedContentHash: hash("user instructions\n"),
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        operationResult: { status: "applied" },
        installationState: { outcome: "partial", usableBy: { "claude-code": "ready" } },
      },
    });
    expect(await readFile(path.join(workspaceRoot, "CLAUDE.md"), "utf8")).toBe("user instructions\n@CLAUDE.vidcom.md\n");
  });

  it("rejects empty hosts, Codex link, branch extras, and wrong-host replace at the strict schema boundary", () => {
    for (const input of [
      { operation: "install", hosts: [] },
      { operation: "link", host: "codex", expectedContentHash: hash("x") },
      { operation: "install", hosts: ["codex"], host: "codex" },
    ]) expect(InstallAgentKitInputSchema.safeParse(input).success).toBe(false);
    expect(InstallAgentKitInputSchema.safeParse({ hosts: ["codex"] }).success).toBe(true);
  });

  it("rejects a replace path from the other host manifest before writing", async () => {
    const result = await createInstaller().apply(workspaceRoot, {
      operation: "replace",
      host: "codex",
      relativePath: ".claude/skills/vidcom/SKILL.md",
      expectedContentHash: hash("unused"),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "schema_invalid", field: "relativePath" } });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_operation")).toEqual({ count: 0 });
  });

  it("rolls back every installer file when publication fails midway", async () => {
    let publishes = 0;
    const failing = new Proxy(workspace, {
      get(target, property) {
        if (property === "publishCaptured") {
          return async (...args: Parameters<WorkspaceFs["publishCaptured"]>) => {
            publishes += 1;
            if (publishes === 3) throw new Error("injected failure");
            return target.publishCaptured(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkspacePort;
    const result = await createInstaller(failing).apply(workspaceRoot, { operation: "install", hosts: ["codex"] });
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    await expect(readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM revision")).toEqual({ count: 0 });
    expect(dbAll(database, "SELECT status FROM workspace_operation")).toEqual([{ status: "recovered" }]);
  });
});
