/**
 * The states a foundation can be in, and the transitions that are allowed.
 *
 * Written as data rather than as scattered `if` statements because the bug this
 * replaces was a state that looked stopped from one angle and running from
 * another: routes still registered, discovery record still published, lease
 * already gone. A single table makes an illegal move impossible to reach by
 * accident.
 */
export type FoundationState =
  | "no-workspace"
  | "activating"
  | "active"
  | "reacquiring"
  | "switching"
  | "stopping";

export type FoundationEvent =
  | "activate"
  | "activated"
  | "activation-failed"
  | "lease-lost"
  | "lease-reacquired"
  | "reacquire-failed"
  | "switch"
  | "switched"
  | "switch-rolled-back"
  | "stop"
  | "stopped";

const TRANSITIONS: Readonly<Record<FoundationState, Partial<Record<FoundationEvent, FoundationState>>>> = {
  "no-workspace": {
    activate: "activating",
    stop: "stopping",
  },
  activating: {
    activated: "active",
    // A failed activation returns to no-workspace rather than active: a
    // half-built foundation must never be reachable.
    "activation-failed": "no-workspace",
  },
  active: {
    // Losing the lease does not stop the foundation. Writes are refused and the
    // discovery record is withdrawn immediately, but the object is kept so a
    // successful re-acquire costs nothing to rebuild.
    "lease-lost": "reacquiring",
    switch: "switching",
    stop: "stopping",
  },
  reacquiring: {
    // The same instanceId is kept on the way back, so a client that reconnects
    // is talking to the daemon it was already attached to.
    "lease-reacquired": "active",
    "reacquire-failed": "no-workspace",
    stop: "stopping",
  },
  switching: {
    switched: "active",
    // Rollback returns to active on the previous foundation; only a failed
    // rollback drops to no-workspace.
    "switch-rolled-back": "active",
    "activation-failed": "no-workspace",
  },
  stopping: {
    stopped: "no-workspace",
  },
};

/** The state an event leads to, or `undefined` when the move is not allowed. */
export function nextFoundationState(
  state: FoundationState,
  event: FoundationEvent,
): FoundationState | undefined {
  return TRANSITIONS[state][event];
}

export function canTransition(state: FoundationState, event: FoundationEvent): boolean {
  return nextFoundationState(state, event) !== undefined;
}

/** Every event a state accepts, in declaration order. */
export function allowedEvents(state: FoundationState): readonly FoundationEvent[] {
  return Object.keys(TRANSITIONS[state]) as FoundationEvent[];
}

/**
 * States in which a mutation must be refused.
 *
 * `switching` and `reacquiring` both mean "this process is not the writer right
 * now", which is the only safe reading while a lease is in question.
 */
export function acceptsMutations(state: FoundationState): boolean {
  return state === "active";
}

/** States in which the bridge routes may be registered at all. */
export function servesBridgeRoutes(state: FoundationState): boolean {
  // Not merely refused — absent. A route that answers 403 still proves the
  // daemon believes it owns a workspace.
  return state === "active" || state === "switching";
}
