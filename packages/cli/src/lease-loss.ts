export const LEASE_REACQUIRE_ATTEMPTS = 2;
export const LEASE_REACQUIRE_WINDOW_MS = 30_000;

export type LeaseLossOutcome =
  | { kind: "recovered"; instanceId: string; attempts: number }
  | { kind: "no-workspace"; attempts: number }
  | { kind: "exited"; attempts: number };

export interface LeaseLossDependencies {
  /** Refuses further writes. Must take effect before anything else happens. */
  refuseWrites(): void;
  /** Withdraws the discovery record so no new client attaches. */
  removeDiscoveryRecord(): Promise<void>;
  /** Publishes `workspace.lease_lost`. Emitted before the state changes. */
  emitLeaseLost(): Promise<void>;
  /** One re-acquire attempt; resolves true when the lease is held again. */
  reacquire(): Promise<boolean>;
  /** True when a UI is attached, which decides the failure path. */
  hasAttachedUi(): boolean;
  /** Drops to the no-workspace state, keeping the listener open for the UI. */
  toNoWorkspace(): Promise<void>;
  /** Closes the listener and exits non-zero, for a headless daemon. */
  exitHeadless(): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Handles a lost workspace lease.
 *
 * The order of the first three actions is not negotiable. Writes are refused
 * and the discovery record is withdrawn **immediately**, before any recovery is
 * attempted, because the process that took the lease is already the writer —
 * every moment this one still accepts writes or advertises itself is a window
 * with two writers.
 *
 * `workspace.lease_lost` is emitted **before** the state changes, so a client
 * watching the stream learns why the state moved rather than seeing it move for
 * no stated reason.
 *
 * Recovery keeps the original `instanceId`. A client that reconnects after a
 * successful re-acquire is talking to the same daemon it was attached to, and
 * handing it a new identity would make a recovered blip look like a restart.
 */
export async function handleLeaseLoss(
  instanceId: string,
  dependencies: LeaseLossDependencies,
): Promise<LeaseLossOutcome> {
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  }));

  // Both before any recovery attempt: the other process is already writing.
  dependencies.refuseWrites();
  await dependencies.removeDiscoveryRecord();
  await dependencies.emitLeaseLost();

  const deadline = now() + LEASE_REACQUIRE_WINDOW_MS;
  let attempts = 0;
  while (attempts < LEASE_REACQUIRE_ATTEMPTS && now() < deadline) {
    attempts += 1;
    if (await dependencies.reacquire()) {
      return { kind: "recovered", instanceId, attempts };
    }
    if (attempts < LEASE_REACQUIRE_ATTEMPTS && now() < deadline) {
      await sleep(Math.max(0, Math.min(1_000, deadline - now())));
    }
  }

  // Two different failures, because the two deployments fail differently. With a
  // UI attached the port must stay open so the user can pick another workspace;
  // headless there is nobody to tell, and a daemon that keeps listening without
  // a workspace is a process a supervisor believes is healthy.
  if (dependencies.hasAttachedUi()) {
    await dependencies.toNoWorkspace();
    return { kind: "no-workspace", attempts };
  }
  await dependencies.exitHeadless();
  return { kind: "exited", attempts };
}
