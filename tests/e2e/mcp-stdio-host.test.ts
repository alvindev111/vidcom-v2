import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
import { heavyE2eTimeout, removeTree } from "../support/platform";

const executeFile = promisify(execFile);
const modernRevision = "2026-07-28";
const legacyRevision = "2025-11-25";

const onWindows = process.platform === "win32";

interface CliArtifact {
  cwd: string;
  envPath: string;
  /** Removes the staging directory this artifact placed inside the checkout. */
  cleanup(): Promise<void>;
}

async function createResolvedCliArtifact(root: string): Promise<CliArtifact> {
  // Phase 2 is a source-checkout package, so the clean packed CLI has to reuse
  // the checkout's installed dependency graph; Phase 4 owns a self-contained
  // SEA. Staging the artifact *inside* packages/cli means Node's ordinary
  // upward node_modules walk finds `tsx` and the workspace packages, with no
  // symlink or junction to resolve. Linking a node_modules into a temp
  // directory instead is what broke on Windows: the link resolved locally but
  // not on a GitHub runner, whose package layout and 8.3 temp paths differ.
  const artifactRoot = path.join(path.resolve("packages/cli"), `.artifact-${path.basename(root)}`);
  const hostRoot = path.join(root, "host");
  const hostBin = path.join(hostRoot, "node_modules", ".bin");
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(hostBin, { recursive: true });

  // npm ships as npm.cmd on Windows, which cannot be spawned without a shell
  // since the CVE-2024-27980 fix. Quote the one interpolated path so a shell
  // command line survives a directory containing spaces.
  const packDestination = onWindows ? `"${artifactRoot}"` : artifactRoot;
  const packed = await executeFile(
    onWindows ? "npm.cmd" : "npm",
    ["pack", "--pack-destination", packDestination, "--json", "--ignore-scripts"],
    { cwd: path.resolve("packages/cli"), encoding: "utf8", shell: onWindows },
  );
  const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  await executeFile("tar", ["-xzf", path.join(artifactRoot, filename), "-C", artifactRoot]);

  const unpackedPackage = path.join(artifactRoot, "package");
  const launcher = path.join(unpackedPackage, "bin", "vidcom.mjs");
  // Windows carries no executable bit; there the launcher is reached through the
  // .cmd shim written below, exactly as an npm install would provide it.
  if (!onWindows) expect((await stat(launcher)).mode & 0o111).not.toBe(0);

  // Fail with the cause rather than as a downstream "connection closed" if the
  // dependency graph the launcher needs is not reachable from where it sits.
  const require = createRequire(path.join(unpackedPackage, "bin", "vidcom.mjs"));
  expect(() => require.resolve("tsx/esm/api")).not.toThrow();

  if (onWindows) {
    // PATH lookup on Windows goes through PATHEXT, so the host resolves the
    // `vidcom` command name via this shim — the same shape npm generates.
    await writeFile(
      path.join(hostBin, "vidcom.cmd"),
      `@node "${launcher}" %*\r\n`,
    );
  } else {
    await symlink(launcher, path.join(hostBin, "vidcom"), "file");
  }
  return {
    cwd: hostRoot,
    envPath: `${hostBin}${path.delimiter}${process.env.PATH ?? ""}`,
    cleanup: () => removeTree(artifactRoot),
  };
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
      expect((await legacy.listTools()).tools.map((tool) => tool.name)).toHaveLength(13);
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
          shell: onWindows,
        });
        approvalStdout = approved.stdout;
        return { action: "accept" as const, content: { grantId: requestId } };
      });
      await modern.connect(modernTransport);
      expect((await modern.listTools()).tools.map((tool) => tool.name)).toHaveLength(13);
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
      await artifact.cleanup();
      await removeTree(root);
    }
  }, heavyE2eTimeout);

  it("returns one redacted stderr line for a real launcher infrastructure failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-cli-error-smoke-"));
    const notDirectory = path.join(root, "not-a-directory");
    const artifact = await createResolvedCliArtifact(root);
    try {
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
          // The Windows entry point is a .cmd shim, which needs a shell.
          shell: onWindows,
        });
      } catch (error) {
        failure = error as ExecFailure;
      }
      expect(failure).toMatchObject({ code: 1, stdout: "", stderr: "internal_error\n" });
      expect(failure?.stderr).not.toContain(root);
    } finally {
      await artifact.cleanup();
      await removeTree(root);
    }
  }, heavyE2eTimeout);
});
