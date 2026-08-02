import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { initializeDatabase } from "@vidcom/adapter";
import type { ContentHash, ProjectId } from "@vidcom/contracts";

import { dbAll, dbOne } from "../support/database";

const executeFile = promisify(execFile);
const modernRevision = "2026-07-28";
const legacyRevision = "2025-11-25";

async function createResolvedCliArtifact(root: string): Promise<{ cwd: string; envPath: string }> {
  const artifactRoot = path.join(root, "cli-artifact");
  const hostRoot = path.join(root, "host");
  const hostBin = path.join(hostRoot, "node_modules", ".bin");
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(hostBin, { recursive: true });

  const packed = await executeFile(
    "npm",
    ["pack", "--pack-destination", artifactRoot, "--json", "--ignore-scripts"],
    { cwd: path.resolve("packages/cli"), encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  await executeFile("tar", ["-xzf", path.join(artifactRoot, filename), "-C", artifactRoot]);

  const unpackedPackage = path.join(artifactRoot, "package");
  const launcher = path.join(unpackedPackage, "bin", "vidcom.mjs");
  expect((await stat(launcher)).mode & 0o111).not.toBe(0);

  // Phase 2 is a source-checkout package, so the clean packed CLI reuses the
  // checkout's installed dependency graph. Phase 4 owns a self-contained SEA.
  await symlink(
    path.resolve("packages/cli/node_modules"),
    path.join(unpackedPackage, "node_modules"),
    "dir",
  );
  await symlink(launcher, path.join(hostBin, "vidcom"), "file");
  return { cwd: hostRoot, envPath: `${hostBin}${path.delimiter}${process.env.PATH ?? ""}` };
}

function environment(appData: string): NodeJS.ProcessEnv & Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NODE_ENV: process.env.NODE_ENV ?? "test",
    VIDCOM_APP_DATA: appData,
  } as NodeJS.ProcessEnv & Record<string, string>;
}

async function expectLeaseReleased(appData: string): Promise<void> {
  const database = await initializeDatabase(appData);
  try {
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
      .toEqual({ count: 0 });
  } finally {
    await database.destroy();
  }
}

async function expectDestructiveAudit(appData: string): Promise<void> {
  const database = await initializeDatabase(appData);
  try {
    expect(dbAll(database, `SELECT action, outcome, error_code AS errorCode,
      protocol_version AS protocolVersion, revision_id AS revisionId
      FROM audit_entry WHERE action = 'tool:delete_file' ORDER BY id`))
      .toEqual([
        {
          action: "tool:delete_file",
          outcome: "error",
          errorCode: "approval_required",
          protocolVersion: modernRevision,
          revisionId: null,
        },
        {
          action: "tool:delete_file",
          outcome: "ok",
          errorCode: null,
          protocolVersion: modernRevision,
          revisionId: 1,
        },
      ]);
  } finally {
    await database.destroy();
  }
}

describe("exact MCP SDK CLI smoke", () => {
  it("spawns legacy then modern, completes approval and shuts down with protocol-only stdout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-sdk-host-smoke-"));
    const workspace = path.join(root, "workspace");
    const projectRoot = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    const projectId = "project_ai_host_smoke" as ProjectId;
    const unused = "unused.txt";
    const unusedContent = "delete me";
    const unusedHash = `sha256:${createHash("sha256").update(unusedContent).digest("hex")}` as ContentHash;
    const env = environment(appData);
    const artifact = await createResolvedCliArtifact(root);
    env.PATH = artifact.envPath;
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(
      path.join(projectRoot, "index.html"),
      '<main data-composition-id="root" data-duration="1" data-width="1920" data-height="1080"></main>',
    );
    await writeFile(path.join(projectRoot, unused), unusedContent);

    try {
      const legacyTransport = new LegacyStdio({
        command: "vidcom",
        args: ["mcp", "--workspace", workspace, "--protocol", legacyRevision],
        cwd: artifact.cwd,
        env,
        stderr: "pipe",
      });
      const legacyStderr: Buffer[] = [];
      legacyTransport.stderr?.on("data", (chunk: Buffer) => legacyStderr.push(chunk));
      const legacy = new LegacyClient({ name: "vidcom-sdk-host-legacy", version: "1.0.0" });
      await legacy.connect(legacyTransport);
      expect((await legacy.listTools()).tools.map((tool) => tool.name)).toHaveLength(10);
      const legacyCall = await legacy.callTool({ name: "list_projects", arguments: {} });
      expect(legacyCall.structuredContent).toMatchObject({ projects: [{ projectId }] });
      await legacy.close();
      expect(legacyTransport.pid).toBeNull();
      expect(Buffer.concat(legacyStderr).toString("utf8")).toBe("");
      await expectLeaseReleased(appData);

      let approvalStdout = "";
      const modernTransport = new ModernStdio({
        command: "vidcom",
        args: ["mcp", "--workspace", workspace, "--protocol", modernRevision],
        cwd: artifact.cwd,
        env,
        stderr: "pipe",
      });
      const modernStderr: Buffer[] = [];
      modernTransport.stderr?.on("data", (chunk: Buffer) => modernStderr.push(chunk));
      const modern = new ModernClient(
        { name: "vidcom-sdk-host-modern", version: "1.0.0" },
        {
          capabilities: { elicitation: { form: {} } },
          versionNegotiation: { mode: { pin: modernRevision } },
        },
      );
      modern.setRequestHandler("elicitation/create", async (request) => {
        const message = (request as { params?: { message?: unknown } }).params?.message;
        const requestId = typeof message === "string"
          ? /Approve request ([^, ]+)/.exec(message)?.[1]
          : undefined;
        if (!requestId) throw new Error(`unexpected elicitation request: ${JSON.stringify(request)}`);
        const approved = await executeFile("vidcom", ["approve", requestId], {
          cwd: artifact.cwd,
          env,
          encoding: "utf8",
        });
        approvalStdout = approved.stdout;
        return { action: "accept" as const, content: { grantId: requestId } };
      });
      await modern.connect(modernTransport);
      expect((await modern.listTools()).tools.map((tool) => tool.name)).toHaveLength(10);
      const deleted = await modern.callTool({
        name: "delete_file",
        arguments: { projectId, path: unused, expectedContentHash: unusedHash },
      });
      expect(deleted.structuredContent).toMatchObject({ deleted: unused });
      expect(JSON.parse(approvalStdout.trim())).toMatchObject({ grantId: expect.any(String) });
      await modern.close();
      expect(modernTransport.pid).toBeNull();
      expect(Buffer.concat(modernStderr).toString("utf8")).toBe("");
      await expect(access(path.join(projectRoot, unused))).rejects.toMatchObject({ code: "ENOENT" });
      await expectLeaseReleased(appData);
      await expectDestructiveAudit(appData);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("returns one redacted stderr line for a real launcher infrastructure failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-cli-error-smoke-"));
    const notDirectory = path.join(root, "not-a-directory");
    try {
      const artifact = await createResolvedCliArtifact(root);
      await writeFile(notDirectory, "blocking file");
      const env = environment(path.join(notDirectory, "child"));
      env.PATH = artifact.envPath;
      type ExecFailure = Error & { code?: number; stdout?: string; stderr?: string };
      let failure: ExecFailure | null = null;
      try {
        await executeFile("vidcom", ["credential", "list"], {
          cwd: artifact.cwd,
          env,
          encoding: "utf8",
        });
      } catch (error) {
        failure = error as ExecFailure;
      }
      expect(failure).toMatchObject({ code: 1, stdout: "", stderr: "internal_error\n" });
      expect(failure?.stderr).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
