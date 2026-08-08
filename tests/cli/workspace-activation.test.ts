import {
  WorkspaceActivationCoordinator,
  WorkspaceActivationError,
  type ActivatedFoundation,
  type ActivationDependencies,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

function harness(overrides: Partial<ActivationDependencies> = {}) {
  const events: string[] = [];
  const recorded: string[] = [];
  const stopped: string[] = [];

  const foundation = (workspaceRoot: string): ActivatedFoundation => ({
    workspaceRoot,
    stop: async () => { stopped.push(workspaceRoot); },
  });

  const dependencies: ActivationDependencies = {
    canonicalize: async (root) => { events.push(`canonicalize:${root}`); return root.replace(/\/+$/u, ""); },
    countRunningJobs: async () => { events.push("countRunningJobs"); return 0; },
    build: async (root) => { events.push(`build:${root}`); return foundation(root); },
    recordActive: async (root) => { events.push(`record:${root}`); recorded.push(root); },
    ...overrides,
  };

  return {
    events, recorded, stopped, foundation,
    coordinator: new WorkspaceActivationCoordinator(dependencies),
  };
}

describe("workspace activation", () => {
  it("canonicalizes and builds before touching anything, then records last", async () => {
    const value = harness();
    await value.coordinator.activate("/w/one");

    expect(value.events).toEqual([
      "canonicalize:/w/one", "countRunningJobs", "build:/w/one", "record:/w/one",
    ]);
    expect(value.coordinator.activeWorkspace).toBe("/w/one");
  });

  it("does not record a workspace whose activation failed", async () => {
    const value = harness({ build: () => Promise.reject(new Error("port in use")) });

    await expect(value.coordinator.activate("/w/one")).rejects.toBeInstanceOf(WorkspaceActivationError);
    // A pointer written before the swap can outlive an activation that never
    // completed, which is why recording is the last step.
    expect(value.recorded).toEqual([]);
    expect(value.coordinator.activeWorkspace).toBeNull();
  });

  it("keeps the previous workspace serving when the new one fails to build", async () => {
    let attempt = 0;
    const value = harness({
      build: async (root) => {
        attempt += 1;
        if (attempt === 2) throw new Error("second build failed");
        return { workspaceRoot: root, stop: async () => {} };
      },
    });
    await value.coordinator.activate("/w/one");

    await expect(value.coordinator.activate("/w/two")).rejects.toBeInstanceOf(WorkspaceActivationError);
    expect(value.coordinator.activeWorkspace).toBe("/w/one");
    expect(value.recorded).toEqual(["/w/one"]);
  });

  it("refuses a switch while jobs are still running", async () => {
    const value = harness({ countRunningJobs: () => Promise.resolve(2) });

    const failure = await value.coordinator.activate("/w/one").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspaceActivationError);
    expect((failure as WorkspaceActivationError).code).toBe(ErrorCode.WorkspaceBusy);
    // Refused, not queued: tearing down under a running job abandons work that
    // has already written to the workspace.
    expect(value.events).not.toContain("build:/w/one");
  });

  it("treats two spellings of one directory as no switch at all", async () => {
    const value = harness();
    await value.coordinator.activate("/w/one");
    const again = await value.coordinator.activate("/w/one/");

    expect(again.swapped).toBe(false);
    expect(value.stopped).toEqual([]);
    expect(value.events.filter((event) => event.startsWith("build:"))).toEqual(["build:/w/one"]);
  });

  it("stops the previous foundation exactly once on a real switch", async () => {
    const value = harness();
    await value.coordinator.activate("/w/one");
    await value.coordinator.activate("/w/two");

    expect(value.stopped).toEqual(["/w/one"]);
    expect(value.coordinator.activeWorkspace).toBe("/w/two");
    expect(value.recorded).toEqual(["/w/one", "/w/two"]);
  });

  it("rolls back when the previous foundation refuses to stop", async () => {
    const stubborn: ActivatedFoundation = {
      workspaceRoot: "/w/one",
      stop: () => Promise.reject(new Error("scheduler still draining")),
    };
    let built = 0;
    const takenDown: string[] = [];
    const value = harness({
      build: async (root) => {
        built += 1;
        if (built === 1) return stubborn;
        return { workspaceRoot: root, stop: async () => { takenDown.push(root); } };
      },
    });
    await value.coordinator.activate("/w/one");

    const failure = await value.coordinator.activate("/w/two").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspaceActivationError);
    // Two live foundations would mean two writers, so the new one is taken back
    // down and the old one stays active.
    expect(takenDown).toEqual(["/w/two"]);
    expect(value.coordinator.activeWorkspace).toBe("/w/one");
    expect(value.recorded).toEqual(["/w/one"]);
  });

  it("refuses a second switch that arrives mid-flight", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const value = harness({
      build: async (root) => {
        await held;
        return { workspaceRoot: root, stop: async () => {} };
      },
    });

    const first = value.coordinator.activate("/w/one");
    expect(value.coordinator.switching).toBe(true);
    // Queued would mean deciding against a state that is about to change.
    const failure = await value.coordinator.activate("/w/two").catch((error: unknown) => error);
    expect((failure as WorkspaceActivationError).code).toBe(ErrorCode.WorkspaceSwitching);

    release();
    await first;
    expect(value.coordinator.activeWorkspace).toBe("/w/one");
  });

  it("rejects an unusable path before counting jobs or building", async () => {
    const value = harness({ canonicalize: () => Promise.reject(new Error("no such directory")) });

    await expect(value.coordinator.activate("/missing")).rejects.toThrow(/no such directory/u);
    expect(value.events).toEqual([]);
  });
});
