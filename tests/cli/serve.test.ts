import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonDiscoveryStore } from "@vidcom/adapter";
import {
  CliInputError,
  parseServeCommandArgs,
  resolveStaticAssets,
  startServing,
  unbuiltFrontendTarget,
  type ServingDaemon,
} from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  delete process.env.VIDCOM_APP_DATA;
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
    expect(page.headers.get("content-type")).toContain("text/plain");
  }, 60_000);
});
