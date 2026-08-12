import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonDiscoveryStore } from "@vidcom/adapter";
import {
  CliInputError,
  connectRenderClient,
  createSeaStaticAssetHost,
  defaultAppDataRoot,
  hostBrowseTokens,
  parseServeCommandArgs,
  resolveStaticAssets,
  startServing,
  unbuiltFrontendTarget,
  waitForShutdown,
  type ServingDaemon,
} from "@vidcom/cli";
import { sessionFingerprint } from "@vidcom/server";
import { configureCompilerBeforeRuntime } from "../../packages/cli/src/compiler-preload";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  delete process.env.VIDCOM_APP_DATA;
  delete process.env.VIDCOM_SETTINGS;
  delete process.env.VIDCOM_WORKSPACE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<{ appData: string; workspace: string }> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-serve-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { appData: path.join(root, "app-data"), workspace };
}

async function serve(): Promise<{ daemon: ServingDaemon; appData: string; workspace: string }> {
  const { appData, workspace } = await scratch();
  process.env.VIDCOM_APP_DATA = appData;
  const daemon = await startServing({ workspace });
  daemons.push(daemon);
  return { daemon, appData, workspace };
}

async function exchange(daemon: ServingDaemon, nonce: string): Promise<string> {
  const response = await fetch(`${daemon.baseUrl}/api/v1/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

function browseSession(cookie: string): string {
  const token = cookie.split("=", 2)[1];
  if (!token) throw new Error("browser session cookie is missing its token");
  return sessionFingerprint(token);
}

function stealLease(appData: string): void {
  const database = new DatabaseSync(path.join(appData, "vidcom.sqlite"));
  try {
    database.prepare("UPDATE workspace_lease SET lease_id = ?, holder_id = ?, expires_at = ?")
      .run("lease_stolen", "other-writer", new Date(Date.now() + 60_000).toISOString());
  } finally {
    database.close();
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition did not become true before its deadline");
}

describe("serve arguments", () => {
  it("takes the workspace, the port and the on-demand flag", () => {
    expect(parseServeCommandArgs(["--workspace", "/w", "--port", "43127", "--ensure"]))
      .toEqual({ workspace: "/w", port: 43_127, ensure: true });
  });

  it("refuses a repeat, a missing value and an unknown flag", () => {
    expect(() => parseServeCommandArgs(["--port"])).toThrow(CliInputError);
    expect(() => parseServeCommandArgs(["--port", "1", "--port", "2"])).toThrow(CliInputError);
    expect(() => parseServeCommandArgs(["--open"])).toThrow(CliInputError);
    expect(() => parseServeCommandArgs(["--port", "0"])).toThrow(CliInputError);
  });
});

describe("serve static assets", () => {
  it("serves the pack a build put on disk", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-assets-")));
    roots.push(root);
    await writeFile(path.join(root, "frontend.pack"), "hello", "utf8");
    await writeFile(path.join(root, "frontend-manifest.json"), "{}", "utf8");
    // A checkout that ran build:artifact has the same two files a packaged
    // executable carries, which is what makes the packaged UI testable without
    // packaging.
    expect(resolveStaticAssets(root)).not.toBeNull();
  });

  it("reads the pack once, not once per request", async () => {
    // Found by reviewing the diff. Constructing the host parses the manifest
    // and bounds-checks every entry; doing that per request repeats the whole
    // thing for every image on a page.
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-assets-")));
    roots.push(root);
    await writeFile(path.join(root, "frontend.pack"), "hello", "utf8");
    await writeFile(path.join(root, "frontend-manifest.json"), "{}", "utf8");

    let reads = 0;
    const source = resolveStaticAssets(root);
    expect(source).not.toBeNull();
    const counted = {
      getRawAsset(key: string): ArrayBuffer {
        reads += 1;
        return source!.getRawAsset(key);
      },
    };
    // An empty manifest is refused at construction, which is itself the proof
    // that construction is where the reading happens.
    expect(() => createSeaStaticAssetHost(counted)).toThrow();
    expect(reads).toBeGreaterThan(0);
  });

  it("asks Node for the embedded assets rather than a global require", async () => {
    // Found by reviewing the diff. Inside a single executable `require` is a
    // module-scope binding, not a global — reaching for it through `globalThis`
    // finds nothing, and a packaged build would fall through to the on-disk
    // branch and serve "not built" while carrying the frontend.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("packages/cli/src/commands/serve.ts", "utf8");
    expect(source).toContain("process.getBuiltinModule");
    expect(source).not.toContain("globalThis as { require");
  });

  it("says what is missing rather than serving an empty page", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-assets-")));
    roots.push(root);
    expect(resolveStaticAssets(root)).toBeNull();

    // An empty page reads as a broken app; naming the command that fixes it is
    // the difference between a dead end and a next step.
    const response = await unbuiltFrontendTarget()(new Request("http://127.0.0.1/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("build:artifact");
  });
});

describe("serve", () => {
  it("accepts a parent IPC shutdown and removes its process listeners", async () => {
    const listenerCounts = {
      message: process.listenerCount("message"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    let stops = 0;
    const daemon = {
      stop: async () => { stops += 1; },
      failure: new Promise<never>(() => {}),
    } as unknown as ServingDaemon;

    const waiting = waitForShutdown(daemon);
    (process as unknown as { emit(event: "message", message: unknown): boolean })
      .emit("message", { type: "vidcom.shutdown" });
    await waiting;

    expect(stops).toBe(1);
    expect(process.listenerCount("message")).toBe(listenerCounts.message);
    expect(process.listenerCount("SIGINT")).toBe(listenerCounts.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(listenerCounts.sigterm);
  });

  it("uses the preloaded settings root for discovery and render attachment", async () => {
    const { appData, workspace } = await scratch();
    const settingsPath = path.join(path.dirname(appData), "setting.json");
    await writeFile(settingsPath, JSON.stringify({ appDataRoot: appData }));
    delete process.env.VIDCOM_APP_DATA;
    process.env.VIDCOM_SETTINGS = settingsPath;

    await configureCompilerBeforeRuntime();
    expect(process.env.VIDCOM_APP_DATA).toBe(appData);
    expect(defaultAppDataRoot()).toBe(appData);

    const daemon = await startServing({ workspace });
    daemons.push(daemon);
    expect(await new DaemonDiscoveryStore(appData).read(workspace)).toMatchObject({
      instanceId: daemon.instanceId,
      port: daemon.listener.port,
    });

    const attached = await connectRenderClient([
      "project_settings_root",
      "--workspace",
      workspace,
    ]);
    await attached.client.detach(attached.attachmentId);
  }, 60_000);

  it("publishes a discovery record only once it is answering", async () => {
    const { daemon, appData } = await serve();
    const record = await new DaemonDiscoveryStore(appData).read(daemon.workspaceRoot);
    expect(record).toMatchObject({
      instanceId: daemon.instanceId,
      host: "127.0.0.1",
      port: daemon.listener.port,
      pid: process.pid,
    });
    // Answering means the listener is up, which is the claim the record makes.
    const health = await fetch(`${daemon.baseUrl}/api/v1/health`, {
      headers: { Host: `127.0.0.1:${daemon.listener.port}` },
    });
    expect(health.status).not.toBe(0);
  }, 60_000);

  it("removes its record before it lets go of the workspace", async () => {
    // A record that outlives the daemon points clients at nothing, and they
    // spend a handshake finding that out.
    const { daemon, appData } = await serve();
    daemons.splice(daemons.indexOf(daemon), 1);
    await daemon.stop();
    expect(await new DaemonDiscoveryStore(appData).read(daemon.workspaceRoot)).toBeNull();
  }, 60_000);

  it("tears down once however many callers ask", async () => {
    // A signal handler and an error path both reach stop(), and running the
    // teardown twice releases a lease this process no longer holds.
    const { daemon } = await serve();
    daemons.splice(daemons.indexOf(daemon), 1);
    await Promise.all([daemon.stop(), daemon.stop()]);
    await expect(daemon.stop()).resolves.toBeUndefined();
  }, 60_000);

  it("routes the API and the frontend to different targets on one port", async () => {
    const { daemon } = await serve();
    const host = `127.0.0.1:${daemon.listener.port}`;
    // Same port, same origin: that is what lets the packaged UI keep a
    // SameSite=Strict cookie without any cross-origin configuration.
    const api = await fetch(`${daemon.baseUrl}/api/v1/health`, { headers: { Host: host } });
    const page = await fetch(`${daemon.baseUrl}/`, { headers: { Host: host } });
    expect(api.headers.get("content-type")).toContain("application/json");
    // The page target is whichever one this checkout has: `text/html` once a
    // build has produced a pack, `text/plain` for the "not built yet" notice.
    // Asserting one of them made this test depend on whether somebody had run
    // build:artifact, which is not what it is checking — the claim is that the
    // two paths reach different targets on one port.
    expect(page.headers.get("content-type")).not.toContain("application/json");
  }, 60_000);

  it("switches the production listener to a new foundation without losing the session", async () => {
    const { appData, workspace } = await scratch();
    const nextWorkspace = path.join(path.dirname(workspace), "workspace-two");
    await mkdir(nextWorkspace);
    process.env.VIDCOM_APP_DATA = appData;
    const nonce = Buffer.alloc(32, 21).toString("base64url");
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    const daemon = await startServing({ workspace });
    daemons.push(daemon);
    const cookie = await exchange(daemon, nonce);
    const identity = await stat(nextWorkspace, { bigint: true });
    const selectionToken = hostBrowseTokens.mint({
      sessionId: browseSession(cookie),
      canonicalPath: nextWorkspace,
      identity: { device: String(identity.dev), inode: String(identity.ino) },
    }).token;

    const switched = await fetch(`${daemon.baseUrl}/api/v1/workspace/active`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ selectionToken }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({ workspaceRoot: nextWorkspace });

    const workspaceResponse = await fetch(`${daemon.baseUrl}/api/v1/system/workspace`, {
      headers: { Cookie: cookie },
    });
    expect(await workspaceResponse.json()).toEqual({ workspaceRoot: nextWorkspace });
    expect(await new DaemonDiscoveryStore(appData).read(workspace)).toBeNull();
    expect(await new DaemonDiscoveryStore(appData).read(nextWorkspace)).toMatchObject({
      instanceId: daemon.instanceId,
      port: daemon.listener.port,
    });
    const created = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "After Switch", presetId: "vertical-shorts" }),
    });
    expect(created.status).toBe(201);
    await expect(stat(path.join(nextWorkspace, "after-switch", "vidcom.json"))).resolves.toBeDefined();
  }, 90_000);

  it("drops to the bootstrap surface after lease loss when a UI session exists", async () => {
    const { appData, workspace } = await scratch();
    process.env.VIDCOM_APP_DATA = appData;
    const nonce = Buffer.alloc(32, 22).toString("base64url");
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    const daemon = await startServing({ workspace });
    daemons.push(daemon);
    const cookie = await exchange(daemon, nonce);
    stealLease(appData);

    const discovery = new DaemonDiscoveryStore(appData);
    await waitUntil(async () => await discovery.read(workspace) === null);
    const bridge = await fetch(`${daemon.baseUrl}/api/bridge/v1/tools/list_projects`, {
      method: "POST",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(bridge.status).toBe(401);
    expect((await bridge.json()).error.code).toBe("credential_invalid");
    expect((await fetch(`${daemon.baseUrl}/api/v1/health`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(await (await fetch(`${daemon.baseUrl}/api/v1/system/workspace`, {
      headers: { Cookie: cookie },
    })).json()).toEqual({ workspaceRoot: null });
  }, 45_000);

  it("closes a headless listener and rejects its wait after lease loss", async () => {
    const { appData, workspace } = await scratch();
    process.env.VIDCOM_APP_DATA = appData;
    const daemon = await startServing({ workspace });
    daemons.push(daemon);
    const failed = expect(daemon.failure).rejects.toThrow("workspace lease was lost");
    stealLease(appData);

    await failed;
    await expect(fetch(`${daemon.baseUrl}/api/v1/health`)).rejects.toThrow();
    expect(await new DaemonDiscoveryStore(appData).read(workspace)).toBeNull();
  }, 45_000);
});
