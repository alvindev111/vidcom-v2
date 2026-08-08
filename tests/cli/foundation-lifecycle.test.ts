import { createLifecycleHandle, type TeardownStep } from "@vidcom/cli";
import { describe, expect, it } from "vitest";

function recorder() {
  const order: string[] = [];
  const step = (name: string, run?: () => Promise<void> | void): TeardownStep => ({
    name,
    run: async () => {
      order.push(name);
      await run?.();
    },
  });
  return { order, step };
}

describe("foundation lifecycle handle", () => {
  it("runs every step once, in the order given", async () => {
    const { order, step } = recorder();
    const handle = createLifecycleHandle([step("listener"), step("scheduler"), step("lease")]);

    await handle.stop();

    expect(order).toEqual(["listener", "scheduler", "lease"]);
    expect(handle.completedSteps()).toEqual(["listener", "scheduler", "lease"]);
  });

  it("does not run a step twice when stop is called again", async () => {
    const { order, step } = recorder();
    const handle = createLifecycleHandle([step("lease")]);

    await handle.stop();
    await handle.stop();
    await handle.stop();

    // Releasing the same lease twice turns an orderly shutdown into an error.
    expect(order).toEqual(["lease"]);
  });

  it("shares one teardown between concurrent callers", async () => {
    const { order, step } = recorder();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handle = createLifecycleHandle([step("listener", () => held), step("lease")]);

    const first = handle.stop();
    const second = handle.stop();
    release();
    await Promise.all([first, second]);

    // A signal, a lost lease and an explicit stop can all arrive together.
    expect(order).toEqual(["listener", "lease"]);
  });

  it("keeps tearing down after a step throws", async () => {
    const { order, step } = recorder();
    const handle = createLifecycleHandle([
      step("listener"),
      step("scheduler", () => { throw new Error("scheduler refused"); }),
      step("lease"),
    ]);

    await expect(handle.stop()).rejects.toBeInstanceOf(AggregateError);

    // The lease must be released even when something earlier failed: a
    // half-torn-down foundation still holding the lease is the state this
    // phase exists to prevent.
    expect(order).toEqual(["listener", "scheduler", "lease"]);
    expect(handle.completedSteps()).toEqual(["listener", "lease"]);
  });

  it("reports every failure rather than only the first", async () => {
    const { step } = recorder();
    const handle = createLifecycleHandle([
      step("scheduler", () => { throw new Error("scheduler refused"); }),
      step("watcher", () => { throw new Error("watcher refused"); }),
    ]);

    const failure = await handle.stop().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  it("does not retry a failed step on a later stop", async () => {
    let attempts = 0;
    const handle = createLifecycleHandle([{
      name: "scheduler",
      run: () => { attempts += 1; throw new Error("scheduler refused"); },
    }]);

    await handle.stop().catch(() => {});
    await handle.stop().catch(() => {});

    // A step that already failed is not going to succeed by being run again,
    // and retrying it would double any side effect it managed before failing.
    expect(attempts).toBe(1);
  });

  it("reports stopping as soon as stop is called, before teardown finishes", async () => {
    const { step } = recorder();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handle = createLifecycleHandle([step("listener", () => held)]);

    expect(handle.stopping).toBe(false);
    const stopped = handle.stop();
    // Callers deciding whether to accept work need the answer immediately, not
    // after the teardown completes.
    expect(handle.stopping).toBe(true);
    release();
    await stopped;
  });

  it("accepts an empty step list", async () => {
    const handle = createLifecycleHandle([]);
    await handle.stop();
    expect(handle.completedSteps()).toEqual([]);
  });
});
