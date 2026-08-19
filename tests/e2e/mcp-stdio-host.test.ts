import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { DaemonDiscoveryStore, initializeDatabase } from "@vidcom/adapter";
import type { ContentHash, ProjectId } from "@vidcom/contracts";

import { dbOne } from "../support/database";
import { heavyE2eTimeout, removeTree } from "../support/platform";

const executeFile = promisify(execFile);
const modernRevision = "2026-07-28";
const legacyRevision = "2025-11-25";

const onWindows = process.platform === "win32";

interface CliArtifact {
  cwd: string;
  envPath: string;
  launcher: string;
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
    {
      cwd: path.resolve("packages/cli"),
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") },
      shell: onWindows,
    },
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
    launcher,
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

async function expectLeaseCount(appData: string, count: number): Promise<void> {
  const database = await initializeDatabase(appData);
  try {
    expect(dbOne(database, "SELECT COUNT(*) AS count FROM workspace_lease"))
      .toEqual({ count });
  } finally {
    await database.destroy();
  }
}

async function startServingArtifact(
  artifact: CliArtifact,
  workspace: string,
  appData: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [artifact.launcher, "serve", "--workspace", workspace], {
    cwd: artifact.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const discovery = new DaemonDiscoveryStore(appData);
  const canonicalWorkspace = await realpath(workspace);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`manual serve exited ${String(child.exitCode)} before publishing: ${output}`);
    }
    const record = await discovery.read(canonicalWorkspace);
    if (record?.pid === child.pid) return child;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`manual serve did not publish discovery: ${output}`);
}

async function stopServingArtifact(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (child.connected) child.send({ type: "vidcom.shutdown" });
  else child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  }
}

async function waitForLeaseCount(appData: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const database = await initializeDatabase(appData);
    try {
      const lease = dbOne<{ count: number }>(database, "SELECT COUNT(*) AS count FROM workspace_lease");
      if (lease?.count === count) return;
    } finally {
      await database.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`workspace lease count did not become ${String(count)}`);
}

describe("exact MCP SDK CLI smoke", () => {
  it("spawns legacy then modern, writes through one daemon and keeps stdout protocol-only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-sdk-host-smoke-"));
    const workspace = path.join(root, "workspace");
    const projectRoot = path.join(workspace, "project");
    const appData = path.join(root, "app-data");
    const projectId = "project_ai_host_smoke" as ProjectId;
    const unusedSource = '<section data-scene-id="unused"></section>';
    const initialSource = '<main data-composition-id="root" data-duration="1" data-width="1920" data-height="1080"></main>';
    const updatedSource = '<main data-composition-id="root" data-duration="2" data-width="1920" data-height="1080"></main>';
    const initialHash = `sha256:${createHash("sha256").update(initialSource).digest("hex")}` as ContentHash;
    const unusedHash = `sha256:${createHash("sha256").update(unusedSource).digest("hex")}` as ContentHash;
    const unusedPath = path.join(projectRoot, "compositions", "unused.html");
    const env = environment(appData);
    const artifact = await createResolvedCliArtifact(root);
    let serving: ChildProcess | null = null;
    env.PATH = artifact.envPath;
    await mkdir(path.dirname(unusedPath), { recursive: true });
    await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n");
    await writeFile(path.join(projectRoot, "vidcom.json"), JSON.stringify({ id: projectId }));
    await writeFile(path.join(projectRoot, "index.html"), initialSource);
    await writeFile(unusedPath, unusedSource);

    try {
      // Start the UI/serve owner first. Both stdio sessions below must attach
      // to this daemon instead of acquiring a second workspace lease.
      serving = await startServingArtifact(artifact, workspace, appData, env);
      await expectLeaseCount(appData, 1);
      // The already-running daemon owns its prepared runtime. A thin explicit-
      // workspace stdio bridge must not bootstrap this compiler-readable but
      // product-incomplete manifest. The early compiler preload can derive its
      // path; BootstrapCoordinator would reject the missing product entries.
      const staleAssets = path.join(root, "stale-incompatible-runtime-assets");
      await mkdir(staleAssets, { recursive: true });
      await writeFile(path.join(staleAssets, "runtime-manifest.json"), JSON.stringify({
        artifactVersion: "stale-runtime",
        archives: [{
          key: "node",
          platform: `${process.platform}-${process.arch}`,
          target: "node-runtime",
        }],
      }));
      env.VIDCOM_RUNTIME_ASSETS = staleAssets;
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
      expect((await legacy.listTools()).tools.map((tool) => tool.name)).toHaveLength(38);
      const legacyCall = await legacy.callTool({ name: "list_projects", arguments: {} });
      expect(legacyCall.structuredContent).toMatchObject({ projects: [{ projectId }] });
      await legacy.close();
      expect(legacyTransport.pid).toBeNull();
      expect(Buffer.concat(legacyStderr).toString("utf8")).toBe("");
      // Closing stdio detaches only the bridge. The daemon stays the sole
      // writer, so another host and queued jobs can continue using it.
      await expectLeaseCount(appData, 1);

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
        const requestId = /Approve request ([^, ]+)/u.exec(request.params.message)?.[1];
        if (!requestId) return { action: "decline" as const };
        const approved = await executeFile("vidcom", ["approve", requestId], {
          cwd: artifact.cwd,
          env,
          encoding: "utf8",
          shell: onWindows,
        });
        const { grantId } = JSON.parse(approved.stdout) as { grantId: string };
        return { action: "accept" as const, content: { grantId } };
      });
      await modern.connect(modernTransport);
      expect((await modern.listTools()).tools.map((tool) => tool.name)).toHaveLength(38);
      const saved = await modern.callTool({
        name: "save_file",
        arguments: {
          projectId,
          path: "index.html",
          content: updatedSource,
          expectedContentHash: initialHash,
        },
      });
      expect(saved.structuredContent).toMatchObject({ file: { path: "index.html" } });
      const deleted = await modern.callTool({
        name: "delete_file",
        arguments: {
          projectId,
          path: "compositions/unused.html",
          expectedContentHash: unusedHash,
        },
      });
      expect(deleted.structuredContent).toMatchObject({ deleted: "compositions/unused.html" });
      await modern.close();
      expect(modernTransport.pid).toBeNull();
      expect(Buffer.concat(modernStderr).toString("utf8")).toBe("");
      await expect(readFile(path.join(projectRoot, "index.html"), "utf8")).resolves.toBe(updatedSource);
      await expect(readFile(unusedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expectLeaseCount(appData, 1);
    } finally {
      if (serving) await stopServingArtifact(serving);
      await waitForLeaseCount(appData, 0);
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
