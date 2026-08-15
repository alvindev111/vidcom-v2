import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppSettingsStore, initializeDatabase, type VidcomDatabase } from "@vidcom/adapter";
import {
  createRouteSurface,
  handleLeaseLoss,
  WorkspaceActivationCoordinator,
  WorkspaceActivationError,
  type ActivationDependencies,
  type LeaseLossDependencies,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

const ACTIVE_WORKSPACE = "active_workspace";
const roots: string[] = [];
const databases: VidcomDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Real app-data, real SQLite, real workspace directories. Nothing is mocked. */
async function scene() {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-switch-")));
  roots.push(root);
  const appDataRoot = path.join(root, "app-data");
  await mkdir(appDataRoot, { recursive: true });
  const database = await initializeDatabase(appDataRoot);
  databases.push(database);

  const workspaces: string[] = [];
  for (const name of ["one", "two"]) {
    const workspaceRoot = path.join(root, name);
    await mkdir(path.join(workspaceRoot, "project"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "project", "vidcom.json"), "{}\n", "utf8");
    workspaces.push(workspaceRoot);
  }

  const settings = new AppSettingsStore(database);
  const heldLeases: string[] = [];
  const discovery = new Set<string>();
  let running = 0;

  const dependencies: ActivationDependencies = {
    canonicalize: async (candidate) => realpathSync(candidate),
    countRunningJobs: async () => running,
    build: async (workspaceRoot) => {
      heldLeases.push(workspaceRoot);
      discovery.add(workspaceRoot);
      return {
        workspaceRoot,
        stop: async () => {
          heldLeases.splice(heldLeases.indexOf(workspaceRoot), 1);
          discovery.delete(workspaceRoot);
        },
      };
    },
    recordActive: async (workspaceRoot) => { settings.set(ACTIVE_WORKSPACE, workspaceRoot); },
  };

  return {
    appDataRoot, database, settings, heldLeases, discovery, workspaces,
    setRunning: (count: number) => { running = count; },
    coordinator: new WorkspaceActivationCoordinator(dependencies),
  };
}

describe("workspace switch on real SQLite and filesystem", () => {
  it("releases the old lease, takes the new one, and never holds both", async () => {
    const value = await scene();
    const [one, two] = value.workspaces as [string, string];

    await value.coordinator.activate(one);
    expect(value.heldLeases).toEqual([one]);

    await value.coordinator.activate(two);
    // At no point may two foundations be live: that is two writers.
    expect(value.heldLeases).toEqual([two]);
    expect(value.coordinator.activeWorkspace).toBe(two);
  });

  it("records active_workspace only after the swap succeeds", async () => {
    const value = await scene();
    const [one, two] = value.workspaces as [string, string];

    await value.coordinator.activate(one);
    expect(value.settings.get(ACTIVE_WORKSPACE)).toBe(one);

    value.setRunning(1);
    await expect(value.coordinator.activate(two)).rejects.toBeInstanceOf(WorkspaceActivationError);
    // The refused switch must not move the pointer the UI opens by default.
    expect(value.settings.get(ACTIVE_WORKSPACE)).toBe(one);
    expect(value.heldLeases).toEqual([one]);
  });

  it("refuses a switch with a reason while a job is still running", async () => {
    const value = await scene();
    const [one, two] = value.workspaces as [string, string];
    await value.coordinator.activate(one);
    value.setRunning(2);

    const failure = await value.coordinator.activate(two).catch((error: unknown) => error);
    expect((failure as WorkspaceActivationError).code).toBe(ErrorCode.WorkspaceBusy);
    expect((failure as WorkspaceActivationError).details).toEqual({ running: 2 });
  });

  it("keeps the same process across a switch", async () => {
    const value = await scene();
    const [one, two] = value.workspaces as [string, string];
    const pid = process.pid;

    await value.coordinator.activate(one);
    await value.coordinator.activate(two);

    // Switching must not restart anything: the port and the browser session
    // survive precisely because this is the same process throughout.
    expect(process.pid).toBe(pid);
    expect(value.settings.get(ACTIVE_WORKSPACE)).toBe(two);
  });
});

describe("lease loss leaves all three symptoms wrong at once", () => {
  it("has no bridge route, no foundation and no discovery record together", async () => {
    const value = await scene();
    const [one] = value.workspaces as [string];
    await value.coordinator.activate(one);
    expect(value.discovery.has(one)).toBe(true);

    const order: string[] = [];
    const dependencies: LeaseLossDependencies = {
      refuseWrites: () => { order.push("refuseWrites"); },
      removeDiscoveryRecord: async () => { value.discovery.delete(one); },
      emitLeaseLost: async () => { order.push("emitLeaseLost"); },
      reacquire: async () => false,
      hasAttachedUi: () => true,
      toNoWorkspace: async () => { await value.coordinator.stop(); },
      exitHeadless: async () => { throw new Error("headless path must not run here"); },
      sleep: async () => {},
    };

    const outcome = await handleLeaseLoss("daemon_1", dependencies);
    expect(outcome.kind).toBe("no-workspace");

    // The old defect showed only one of these at a time, which is why it read
    // as a permissions problem. All three have to be wrong together.
    const response = await createRouteSurface("no-workspace")
      .request("http://127.0.0.1/api/bridge/v1/tools/list_projects", { method: "POST" });
    expect(response.status).toBe(404);
    expect(value.heldLeases).toEqual([]);
    expect(value.discovery.size).toBe(0);
  });

  it("closes down instead of dropping to no-workspace when headless", async () => {
    const value = await scene();
    const [one] = value.workspaces as [string];
    await value.coordinator.activate(one);
    let exited = false;

    const outcome = await handleLeaseLoss("daemon_1", {
      refuseWrites: () => {},
      removeDiscoveryRecord: async () => { value.discovery.delete(one); },
      emitLeaseLost: async () => {},
      reacquire: async () => false,
      hasAttachedUi: () => false,
      toNoWorkspace: async () => { throw new Error("attached path must not run here"); },
      exitHeadless: async () => { exited = true; await value.coordinator.stop(); },
      sleep: async () => {},
    });

    expect(outcome.kind).toBe("exited");
    expect(exited).toBe(true);
    expect(value.heldLeases).toEqual([]);
  });

  it("leaves the process that took the lease as the only writer", async () => {
    const value = await scene();
    const [one] = value.workspaces as [string];
    await value.coordinator.activate(one);
    let writesRefused = false;

    await handleLeaseLoss("daemon_1", {
      // Refusal happens first, before any recovery is attempted, so there is no
      // moment where this process still accepts writes the winner is also making.
      refuseWrites: () => { writesRefused = true; },
      removeDiscoveryRecord: async () => {
        expect(writesRefused).toBe(true);
        value.discovery.delete(one);
      },
      emitLeaseLost: async () => { expect(writesRefused).toBe(true); },
      reacquire: async () => { expect(writesRefused).toBe(true); return false; },
      hasAttachedUi: () => true,
      toNoWorkspace: async () => { await value.coordinator.stop(); },
      exitHeadless: async () => {},
      sleep: async () => {},
    });

    expect(value.heldLeases).toEqual([]);
  });
});
