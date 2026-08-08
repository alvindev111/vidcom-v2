import {
  BOOTSTRAP_ROUTE_PREFIXES,
  createRouteSurface,
  registeredPrefixes,
  WORKSPACE_ROUTE_PREFIXES,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

async function status(state: Parameters<typeof createRouteSurface>[0], route: string): Promise<number> {
  const response = await createRouteSurface(state).request(`http://127.0.0.1${route}`);
  return response.status;
}

describe("bootstrap route surface", () => {
  it("serves only auth, system and health before a workspace is chosen", () => {
    expect(registeredPrefixes("no-workspace")).toEqual([...BOOTSTRAP_ROUTE_PREFIXES]);
    expect(BOOTSTRAP_ROUTE_PREFIXES).toEqual(["/v1/auth", "/v1/system", "/v1/health"]);
  });

  it("answers 404 for bridge routes with no workspace, not 403 or 503", async () => {
    // The distinction is the whole point. A route that refuses still tells the
    // caller the daemon believes it owns a workspace, which is what made the old
    // lease-loss failure read as a permissions problem.
    expect(await status("no-workspace", "/api/bridge/v1/tools/list_projects")).toBe(404);
    expect(await status("no-workspace", "/v1/health")).toBe(200);
  });

  it("keeps bridge routes absent while a lost lease is being re-acquired", async () => {
    // Not merely refusing: during re-acquisition this process is not the writer,
    // and a registered route would say otherwise.
    expect(await status("reacquiring", "/api/bridge/v1/tools/list_projects")).toBe(404);
    expect(registeredPrefixes("reacquiring")).not.toContain(WORKSPACE_ROUTE_PREFIXES[0]);
  });

  it("serves bridge routes once a workspace is genuinely owned", async () => {
    expect(await status("active", "/api/bridge/v1/tools/list_projects")).toBe(200);
    expect(registeredPrefixes("active")).toContain("/api/bridge");
  });

  it("keeps serving the bridge through a switch, which is not a loss of ownership", async () => {
    expect(await status("switching", "/api/bridge/v1/tools/list_projects")).toBe(200);
  });

  it("never registers a workspace route in a state that does not own one", () => {
    for (const state of ["no-workspace", "activating", "reacquiring", "stopping"] as const) {
      for (const prefix of WORKSPACE_ROUTE_PREFIXES) {
        expect(registeredPrefixes(state), state).not.toContain(prefix);
      }
    }
  });

  it("keeps health reachable in every state, since that is how the failure is observed", async () => {
    for (const state of ["no-workspace", "activating", "active", "reacquiring", "stopping"] as const) {
      expect(await status(state, "/v1/health"), state).toBe(200);
    }
  });
});
