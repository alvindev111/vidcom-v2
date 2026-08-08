import {
  acceptsMutations,
  allowedEvents,
  canTransition,
  nextFoundationState,
  servesBridgeRoutes,
  type FoundationEvent,
  type FoundationState,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

const STATES: readonly FoundationState[] = [
  "no-workspace", "activating", "active", "reacquiring", "switching", "stopping",
];

const EVENTS: readonly FoundationEvent[] = [
  "activate", "activated", "activation-failed", "lease-lost", "lease-reacquired",
  "reacquire-failed", "switch", "switched", "switch-rolled-back", "stop", "stopped",
];

describe("foundation state machine", () => {
  it("allows exactly the documented transitions and no others", () => {
    const allowed = STATES.flatMap((state) =>
      allowedEvents(state).map((event) => `${state} --${event}--> ${nextFoundationState(state, event)}`));

    expect(allowed.sort()).toEqual([
      "activating --activated--> active",
      "activating --activation-failed--> no-workspace",
      "active --lease-lost--> reacquiring",
      "active --stop--> stopping",
      "active --switch--> switching",
      "no-workspace --activate--> activating",
      "no-workspace --stop--> stopping",
      "reacquiring --lease-reacquired--> active",
      "reacquiring --reacquire-failed--> no-workspace",
      "reacquiring --stop--> stopping",
      "stopping --stopped--> no-workspace",
      "switching --activation-failed--> no-workspace",
      "switching --switch-rolled-back--> active",
      "switching --switched--> active",
    ]);
  });

  it("refuses every combination outside that table", () => {
    // Enumerated rather than sampled: the bug being prevented was a state
    // reachable only by an unlisted move.
    for (const state of STATES) {
      for (const event of EVENTS) {
        const listed = allowedEvents(state).includes(event);
        expect(canTransition(state, event), `${state} + ${event}`).toBe(listed);
      }
    }
  });

  it("keeps a failed activation out of active", () => {
    // A half-built foundation must not be reachable.
    expect(nextFoundationState("activating", "activation-failed")).toBe("no-workspace");
    expect(nextFoundationState("activating", "activated")).toBe("active");
  });

  it("does not stop the foundation merely because the lease was lost", () => {
    // Keeping the object lets a successful re-acquire cost nothing to rebuild.
    expect(nextFoundationState("active", "lease-lost")).toBe("reacquiring");
    expect(nextFoundationState("reacquiring", "lease-reacquired")).toBe("active");
    expect(nextFoundationState("reacquiring", "reacquire-failed")).toBe("no-workspace");
  });

  it("returns to active after a rolled-back switch", () => {
    expect(nextFoundationState("switching", "switch-rolled-back")).toBe("active");
    expect(nextFoundationState("switching", "activation-failed")).toBe("no-workspace");
  });

  it("accepts mutations only while active", () => {
    // reacquiring and switching both mean this process is not the writer right
    // now, which is the only safe reading while a lease is in question.
    for (const state of STATES) {
      expect(acceptsMutations(state), state).toBe(state === "active");
    }
  });

  it("registers bridge routes only where a workspace is actually owned", () => {
    // Absent, not refused: a route answering 403 still proves the daemon
    // believes it owns a workspace.
    expect(servesBridgeRoutes("no-workspace")).toBe(false);
    expect(servesBridgeRoutes("reacquiring")).toBe(false);
    expect(servesBridgeRoutes("stopping")).toBe(false);
    expect(servesBridgeRoutes("active")).toBe(true);
    expect(servesBridgeRoutes("switching")).toBe(true);
  });

  it("leaves stopping as a one-way street", () => {
    expect(allowedEvents("stopping")).toEqual(["stopped"]);
  });
});
