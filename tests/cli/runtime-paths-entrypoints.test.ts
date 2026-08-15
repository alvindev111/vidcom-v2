import { readFile } from "node:fs/promises";
import path from "node:path";

import { RUNTIME_PATH_NAMES } from "@vidcom/adapter";
import {
  VIDCOM_COMMAND_NAMES,
  runtimePathsFor,
  type VidcomCommandName,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

/**
 * Every mode that needs the daemon's or its own composition runtime.
 *
 * `backup` belongs here because restore builds one even though list and verify
 * remain read-only. `version` and `approve` only read or print; `credential`
 * manages a secret and is explicitly non-composing.
 */
type RuntimeAwareMode = Exclude<VidcomCommandName, "version" | "approve" | "credential">;
type RuntimePathOwnerMode = Exclude<RuntimeAwareMode, "mcp">;

const RUNTIME_ENTRYPOINT_SOURCES = {
  app: "packages/cli/src/next-host.ts",
  serve: "packages/cli/src/next-host.ts",
  render: "packages/cli/src/next-host.ts",
  doctor: "packages/cli/src/next-host.ts",
  backup: "packages/cli/src/commands/backup.ts",
  recovery: "packages/cli/src/commands/recovery.ts",
} as const satisfies Record<RuntimePathOwnerMode, string>;

const COMPOSING_MODES = Object.keys(RUNTIME_ENTRYPOINT_SOURCES) as RuntimePathOwnerMode[];

describe("runtime paths reach every entrypoint", () => {
  it("names modes that the CLI actually publishes", () => {
    for (const mode of [...COMPOSING_MODES, "mcp"] as RuntimeAwareMode[]) {
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
    // `app` and `serve` share the hosted runtime; `render` and `doctor` reach
    // the daemon rather than composing a second one.
    const sources = await Promise.all([...new Set(Object.values(RUNTIME_ENTRYPOINT_SOURCES))]
      .map((source) => readFile(source, "utf8")));
    for (const source of sources) {
      expect(source).toContain("runtimePathsFor");
    }
  });

  it("keeps MCP as a thin daemon bridge without local runtime paths", async () => {
    const source = await readFile("packages/cli/src/commands/mcp.ts", "utf8");
    // The no-workspace fallback may open existing SQLite state to read
    // active_workspace, but even it must not extract/migrate runtime assets.
    expect(source).toContain("openVidcomDatabase");
    expect(source).not.toContain("prepareRuntimeForCli");
    expect(source).not.toContain("runtimePathsFor");
    expect(source).not.toContain("startVidcomFoundation");
    expect(source).not.toContain("createInfrastructure");
  });

  it("keeps the paths off the artifact's require.resolve fallback", () => {
    // The probe used to fall back to require.resolve, which has no meaning
    // inside a single executable with no node_modules to search.
    const paths = runtimePathsFor("/app-data");
    expect(paths.hyperframesCliPath).not.toBe("");
    // Compared with the platform separator: Windows builds `\app-data\native`,
    // and a POSIX literal here would fail on the one platform this rule exists
    // to protect.
    expect(paths.nativeDependenciesRoot).toContain(path.join("/app-data", ""));
  });
});
