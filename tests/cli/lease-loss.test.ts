import {
  handleLeaseLoss,
  LEASE_REACQUIRE_ATTEMPTS,
  LEASE_REACQUIRE_WINDOW_MS,
  type LeaseLossDependencies,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

function harness(overrides: Partial<LeaseLossDependencies> = {}) {
  const order: string[] = [];
  let clock = 0;
  const dependencies: LeaseLossDependencies = {
    refuseWrites: () => { order.push("refuseWrites"); },
    removeDiscoveryRecord: async () => { order.push("removeDiscoveryRecord"); },
    emitLeaseLost: async () => { order.push("emitLeaseLost"); },
    reacquire: async () => { order.push("reacquire"); return false; },
    hasAttachedUi: () => false,
    toNoWorkspace: async () => { order.push("toNoWorkspace"); },
    exitHeadless: async () => { order.push("exitHeadless"); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ...overrides,
  };
  return { order, dependencies, advance: (ms: number) => { clock += ms; } };
}

describe("lease loss", () => {
  it("refuses writes and withdraws discovery before attempting anything", async () => {
    const value = harness();
    await handleLeaseLoss("daemon_1", value.dependencies);

    // The process that took the lease is already writing, so every moment this
    // one still accepts writes or advertises itself is a two-writer window.
    expect(value.order.slice(0, 3)).toEqual([
      "refuseWrites", "removeDiscoveryRecord", "emitLeaseLost",
    ]);
    expect(value.order.indexOf("reacquire")).toBeGreaterThan(value.order.indexOf("removeDiscoveryRecord"));
  });

  it("emits lease_lost before the state changes", async () => {
    const value = harness();
    await handleLeaseLoss("daemon_1", value.dependencies);

    // A client watching the stream should learn why the state moved, not see it
    // move for no stated reason.
    expect(value.order.indexOf("emitLeaseLost"))
      .toBeLessThan(value.order.indexOf("exitHeadless"));
  });

  it("keeps the original instanceId when the lease comes back", async () => {
    const value = harness({ reacquire: async () => true });
    const outcome = await handleLeaseLoss("daemon_1", value.dependencies);

    expect(outcome).toEqual({ kind: "recovered", instanceId: "daemon_1", attempts: 1 });
    // A new identity would make a recovered blip look like a restart to a
    // client that reconnects.
    expect(value.order).not.toContain("toNoWorkspace");
    expect(value.order).not.toContain("exitHeadless");
  });

  it("recovers on the second attempt without spending a third", async () => {
    let calls = 0;
    const value = harness({ reacquire: async () => { calls += 1; return calls === 2; } });

    const outcome = await handleLeaseLoss("daemon_1", value.dependencies);
    expect(outcome).toEqual({ kind: "recovered", instanceId: "daemon_1", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("stops after the attempt budget rather than retrying forever", async () => {
    let calls = 0;
    const value = harness({ reacquire: async () => { calls += 1; return false; } });

    await handleLeaseLoss("daemon_1", value.dependencies);
    expect(calls).toBe(LEASE_REACQUIRE_ATTEMPTS);
  });

  it("stops once the TTL window has passed even with attempts left", async () => {
    let clock = 0;
    let calls = 0;
    const value = harness();

    await handleLeaseLoss("daemon_1", {
      ...value.dependencies,
      now: () => clock,
      // The first attempt runs long enough to consume the whole window.
      reacquire: async () => {
        calls += 1;
        clock += LEASE_REACQUIRE_WINDOW_MS + 1;
        return false;
      },
    });

    // A lease re-acquired after its TTL has already been taken by somebody
    // else, so a second attempt would be racing a live writer.
    expect(calls).toBe(1);
  });

  it("drops to no-workspace when a UI is attached, keeping the port open", async () => {
    const value = harness({ hasAttachedUi: () => true });
    const outcome = await handleLeaseLoss("daemon_1", value.dependencies);

    expect(outcome.kind).toBe("no-workspace");
    // The user needs the port to pick another workspace.
    expect(value.order).toContain("toNoWorkspace");
    expect(value.order).not.toContain("exitHeadless");
  });

  it("closes the listener and exits when headless", async () => {
    const value = harness({ hasAttachedUi: () => false });
    const outcome = await handleLeaseLoss("daemon_1", value.dependencies);

    expect(outcome.kind).toBe("exited");
    // A daemon still listening without a workspace is a process a supervisor
    // believes is healthy.
    expect(value.order).toContain("exitHeadless");
    expect(value.order).not.toContain("toNoWorkspace");
  });

  it("reports how many attempts were spent on either failure path", async () => {
    const attached = harness({ hasAttachedUi: () => true });
    const headless = harness({ hasAttachedUi: () => false });

    expect((await handleLeaseLoss("d", attached.dependencies)).attempts)
      .toBe(LEASE_REACQUIRE_ATTEMPTS);
    expect((await handleLeaseLoss("d", headless.dependencies)).attempts)
      .toBe(LEASE_REACQUIRE_ATTEMPTS);
  });
});
