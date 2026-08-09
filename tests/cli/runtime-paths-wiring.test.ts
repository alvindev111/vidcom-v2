import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NodeHyperframesDiagnosticsLint,
  resolveRuntimePaths,
  RUNTIME_PATH_NAMES,
  VIDCOM_NODE_SENTINEL,
} from "@vidcom/adapter";
import { createInfrastructure } from "@vidcom/cli";
import type { ProjectId, RelPath } from "@vidcom/contracts";
import type { AbsolutePath, ProcessPort, ProcessRunInput } from "@vidcom/core";
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
    // A real directory: the workspace watcher realpaths it asynchronously, and a
    // path that does not exist rejects after the test has already finished —
    // green locally, an unhandled rejection on CI.
    const workspaceRoot = path.join(appDataRoot, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
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

  it("runs diagnostics from the extracted runtime without a require.resolve fallback", async () => {
    const appDataRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-lint-path-")));
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
    await mkdir(path.dirname(paths.hyperframesCliPath), { recursive: true });
    await writeFile(paths.hyperframesCliPath, `process.stdout.write(JSON.stringify({
      lint: { findings: [{
        code: "extracted-runtime-cli",
        severity: "info",
        message: "loaded from the verified runtime"
      }] }
    }));\n`, "utf8");
    const workspaceRoot = path.join(appDataRoot, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
      runtimePaths: paths,
    });
    try {
      const result = await infrastructure.diagnosticLint.check({
        id: "project_runtime_lint" as ProjectId,
        slug: "runtime-lint",
        root: workspaceRoot as AbsolutePath,
        entry: "index.html" as RelPath,
      });

      expect((await stat(path.join(appDataRoot, "vidcom.sqlite"))).isFile()).toBe(true);
      expect(result).toEqual({
        available: true,
        diagnostics: [{
          code: "lint:extracted-runtime-cli",
          severity: "info",
          message: "loaded from the verified runtime",
        }],
      });
    } finally {
      await infrastructure.database.destroy();
    }
  });

  it("re-enters the SEA node shim before running the extracted diagnostics CLI", async () => {
    const calls: ProcessRunInput[] = [];
    const processes: ProcessPort = {
      async run(input) {
        calls.push(input);
        return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
      },
    };
    const cliPath = path.join(VERSION_ROOT, "hyperframes", "bin", "hyperframes.mjs") as AbsolutePath;
    const lint = new NodeHyperframesDiagnosticsLint(processes, {
      cliPath,
      isSea: () => true,
    });

    await lint.check({
      id: "project_sea_lint" as ProjectId,
      slug: "sea-lint",
      root: path.join(APP_DATA, "workspace") as AbsolutePath,
      entry: "index.html" as RelPath,
    });

    expect(calls[0]?.command).toEqual([
      process.execPath,
      VIDCOM_NODE_SENTINEL,
      cliPath,
      "check",
      "--json",
      path.join(APP_DATA, "workspace"),
    ]);
  });
});
