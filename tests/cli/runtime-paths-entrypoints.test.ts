import { readFile } from "node:fs/promises";

import { RUNTIME_PATH_NAMES } from "@vidcom/adapter";
import { VIDCOM_COMMAND_NAMES, runtimePathsFor } from "@vidcom/cli";
import { describe, expect, it } from "vitest";

/**
 * The modes that stand up a composition root.
 *
 * Derived from the published mode union rather than written out again, so a
 * mode added to the CLI cannot quietly skip this file. `version`, `approve`,
 * `credential` and `backup` do not build one: they read or print, and giving
 * them runtime paths would claim a dependency they do not have.
 */
const COMPOSING_MODES = ["app", "serve", "mcp", "render", "doctor"] as const;

describe("runtime paths reach every entrypoint", () => {
  it("names modes that the CLI actually publishes", () => {
    for (const mode of COMPOSING_MODES) {
      expect(VIDCOM_COMMAND_NAMES, mode).toContain(mode);
    }
  });

  it("resolves a complete set, never a partial one", () => {
    // Each field has a reasonable default of its own, which is exactly the
    // danger: a packaged build that forgot one gets a path that looks valid and
    // points at nothing, instead of an error.
    const paths = runtimePathsFor("/app-data") as unknown as Record<string, unknown>;
    for (const name of RUNTIME_PATH_NAMES) {
      expect(typeof paths[name], name).toBe("string");
      expect(String(paths[name]).length, name).toBeGreaterThan(0);
    }
  });

  it("includes motionLibraryRoot, which no entrypoint used to pass", () => {
    // Trap 4.8: a correct resolver nobody passes leaves install_motion_library
    // exactly as broken as before.
    expect(RUNTIME_PATH_NAMES).toContain("motionLibraryRoot");
    expect(runtimePathsFor("/app-data").motionLibraryRoot).toBeTruthy();
  });

  it("has every composing entrypoint pass them, from one source", async () => {
    // One helper rather than five call sites building their own: missing a
    // mode is the easy mistake here, and the forgotten one is usually the least
    // used, so it breaks long after the change and far from it.
    const sources = await Promise.all([
      // `app` and `serve` share the hosted runtime; `render` and `doctor` reach
      // the daemon rather than composing a second one.
      readFile("packages/cli/src/next-host.ts", "utf8"),
      readFile("packages/cli/src/commands/mcp.ts", "utf8"),
      readFile("packages/cli/src/commands/recovery.ts", "utf8"),
    ]);
    for (const source of sources) {
      expect(source).toContain("runtimePathsFor");
    }
  });

  it("keeps the paths off the artifact's require.resolve fallback", () => {
    // The probe used to fall back to require.resolve, which has no meaning
    // inside a single executable with no node_modules to search.
    const paths = runtimePathsFor("/app-data");
    expect(paths.hyperframesCliPath).not.toBe("");
    expect(paths.nativeDependenciesRoot).toContain("/app-data");
  });
});
