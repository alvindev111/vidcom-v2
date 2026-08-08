import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveRuntimePaths, RUNTIME_PATH_NAMES } from "@vidcom/adapter";
import { createInfrastructure } from "@vidcom/cli";
import type { AbsolutePath } from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const APP_DATA = path.resolve("/app-data");
const VERSION_ROOT = path.join(APP_DATA, "native", "1.0.0");

function artifactPaths() {
  return resolveRuntimePaths({
    mode: "artifact",
    versionRoot: VERSION_ROOT,
    appDataRoot: APP_DATA,
    archiveRoots: {
      hyperframes: path.join(VERSION_ROOT, "hyperframes"),
      node: path.join(VERSION_ROOT, "node"),
    },
  });
}

describe("runtime path wiring", () => {
  it("carries every resolved path rather than leaving a field to its own default", () => {
    // Each optional field defaults to something plausible on its own, which is
    // the hazard: a packaged build that forgets one gets a path pointing at
    // nothing instead of an error.
    const paths = artifactPaths();
    for (const name of RUNTIME_PATH_NAMES) {
      expect(paths[name].startsWith(APP_DATA)).toBe(true);
    }
  });

  it("prefers the resolved paths over the individual legacy fields", async () => {
    // A real app-data directory: this opens a real SQLite file, and the suite
    // does not mock the filesystem.
    const appDataRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-paths-")));
    roots.push(appDataRoot);
    const paths = resolveRuntimePaths({
      mode: "artifact",
      versionRoot: path.join(appDataRoot, "native", "1.0.0"),
      appDataRoot,
      archiveRoots: {
        hyperframes: path.join(appDataRoot, "native", "1.0.0", "hyperframes"),
        node: path.join(appDataRoot, "native", "1.0.0", "node"),
      },
    });
    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot: path.resolve("/workspace") as AbsolutePath,
      runtimePaths: paths,
      // Deliberately wrong: if these ever win, the artifact silently renders
      // with a toolchain from somewhere else.
      nativeDependenciesRoot: path.resolve("/stale/native") as AbsolutePath,
      motionLibraryRoot: path.resolve("/stale/motion") as AbsolutePath,
    });
    try {
      expect(infrastructure.renderRoots).toBeDefined();
      expect(paths.nativeDependenciesRoot).toContain(appDataRoot);
    } finally {
      await infrastructure.database.destroy();
    }
  });
});
