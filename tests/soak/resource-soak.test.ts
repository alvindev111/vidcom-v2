import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceFs } from "@vidcom/adapter";
import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  prepareCatalogInstall,
  type AbsolutePath,
  type CatalogInstallDependencies,
  type CatalogInstallIntent,
  type ProjectRef,
} from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

const PROFILE = process.env.VIDCOM_SOAK_PROFILE === "release" ? "release" : "presubmit";
const roots: string[] = [];

function memoryDelta(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage) {
  return {
    heapDeltaBytes: Math.max(0, after.heapUsed - before.heapUsed),
    rssDeltaBytes: Math.max(0, after.rss - before.rss),
  };
}

async function collectMemory(): Promise<NodeJS.MemoryUsage> {
  globalThis.gc?.();
  await new Promise((resolve) => setImmediate(resolve));
  return process.memoryUsage();
}

async function projectFixture(slug: string): Promise<{ workspace: string; project: ProjectRef }> {
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-soak-${slug}-`));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const projectRoot = path.join(workspace, slug);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(path.join(projectRoot, "hyperframes.json"), "{}\n", "utf8");
  await writeFile(path.join(projectRoot, "vidcom.json"), '{"id":"project_soak"}\n', "utf8");
  return {
    workspace,
    project: {
      id: "project_soak" as ProjectId,
      slug,
      root: projectRoot as AbsolutePath,
      entry: "index.html" as RelPath,
    },
  };
}

async function writeManyFiles(root: string, count: number): Promise<void> {
  const directories = 10;
  for (let directory = 0; directory < directories; directory += 1) {
    await mkdir(path.join(root, "compositions", `group-${String(directory).padStart(2, "0")}`), { recursive: true });
  }
  for (let offset = 0; offset < count; offset += 200) {
    await Promise.all(Array.from({ length: Math.min(200, count - offset) }, (_unused, index) => {
      const value = offset + index;
      const directory = value % directories;
      return writeFile(path.join(
        root,
        "compositions",
        `group-${String(directory).padStart(2, "0")}`,
        `scene-${String(value).padStart(5, "0")}.html`,
      ), "", "utf8");
    }));
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resource soak boundaries", () => {
  it("bounds a 10k-file release tree and a sampled presubmit tree", { timeout: 180_000 }, async () => {
    const files = PROFILE === "release" ? 10_000 : 1_000;
    const { workspace, project } = await projectFixture("large-tree");
    await writeManyFiles(project.root, files);
    const adapter = new WorkspaceFs(workspace as AbsolutePath, PROFILE === "release" ? {} : {
      treeLimits: {
        maxDepth: 64,
        maxNodes: 1_000,
        maxEntriesPerDirectory: 2_000,
        maxSerializedBytes: 8 * 1024 * 1024,
        maxDurationMs: 10_000,
      },
    });
    const before = await collectMemory();
    const startedAt = Date.now();
    const error = await adapter.readTree(project).then(() => null, (cause: unknown) => cause);
    const elapsedMs = Date.now() - startedAt;
    const after = await collectMemory();
    const sample = {
      case: "node-count",
      profile: PROFILE,
      files,
      elapsedMs,
      ...memoryDelta(before, after),
      reason: error && typeof error === "object" && "reason" in error ? error.reason : null,
    };
    process.stdout.write(`P17_TREE_SOAK_SAMPLE ${JSON.stringify(sample)}\n`);

    expect(error).toMatchObject({ name: "WorkspaceResourceLimitError", reason: "node_count" });
    expect(sample.heapDeltaBytes).toBeLessThan(32 * 1024 * 1024);
    expect(sample.rssDeltaBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("bounds a production-depth release tree and a sampled presubmit tree", { timeout: 60_000 }, async () => {
    const depthLimit = PROFILE === "release" ? 64 : 16;
    const { workspace, project } = await projectFixture("deep-tree");
    let current = path.join(project.root, "compositions");
    for (let depth = 0; depth <= depthLimit; depth += 1) {
      current = path.join(current, `d${String(depth).padStart(2, "0")}`);
      await mkdir(current, { recursive: true });
    }
    await writeFile(path.join(current, "scene.html"), "", "utf8");
    const adapter = new WorkspaceFs(workspace as AbsolutePath, PROFILE === "release" ? {} : {
      treeLimits: {
        maxDepth: depthLimit,
        maxNodes: 10_000,
        maxEntriesPerDirectory: 2_000,
        maxSerializedBytes: 8 * 1024 * 1024,
        maxDurationMs: 10_000,
      },
    });
    const before = await collectMemory();
    const startedAt = Date.now();
    const error = await adapter.readTree(project).then(() => null, (cause: unknown) => cause);
    const after = await collectMemory();
    const sample = {
      case: "depth",
      profile: PROFILE,
      depth: depthLimit + 1,
      elapsedMs: Date.now() - startedAt,
      ...memoryDelta(before, after),
      reason: error && typeof error === "object" && "reason" in error ? error.reason : null,
    };
    process.stdout.write(`P17_TREE_SOAK_SAMPLE ${JSON.stringify(sample)}\n`);

    expect(error).toMatchObject({ name: "WorkspaceResourceLimitError", reason: "depth" });
    expect(sample.heapDeltaBytes).toBeLessThan(32 * 1024 * 1024);
    expect(sample.rssDeltaBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("repeatedly rejects invalid catalog installs without retaining heap", { timeout: 120_000 }, async () => {
    const attempts = PROFILE === "release" ? 100_000 : 1_000;
    const ref: ProjectRef = {
      id: "project_catalog_soak" as ProjectId,
      slug: "catalog-soak",
      root: "/catalog-soak" as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    let materializeCalls = 0;
    const dependencies = {
      workspace: {
        readProjectRef: async () => ref,
        resolve: async () => { throw new Error("invalid package must not resolve targets"); },
        readHash: async () => { throw new Error("invalid package must not read targets"); },
      },
      composition: {
        parseProject: async () => { throw new Error("invalid package must not parse the project"); },
        applyOps: async () => { throw new Error("invalid package must not mutate the project"); },
      },
      journal: { latestRevision: async () => 0 },
      catalog: {
        materialize: async () => {
          materializeCalls += 1;
          return {
            ok: false as const,
            error: { code: ErrorCode.IntegrityMismatch, message: "invalid catalog package" },
          };
        },
      },
      installedProvenance: async () => null,
      hashContent: () => `sha256:${"0".repeat(64)}` as ContentHash,
      manifestDigest: () => "invalid",
      clock: { now: () => new Date("2026-08-21T00:00:00.000Z") },
    } as unknown as CatalogInstallDependencies;
    const intent: CatalogInstallIntent = {
      projectId: ref.id,
      name: "invalid-package",
      version: "git:0000000000000000000000000000000000000000",
      mount: { kind: "new-scene", toIndex: 0 },
      expectedRevision: 0,
    };
    const signal = new AbortController().signal;
    const before = await collectMemory();
    const startedAt = Date.now();
    let rejected = 0;
    for (let index = 0; index < attempts; index += 1) {
      const result = await prepareCatalogInstall(dependencies, intent, signal);
      if (!result.ok && result.error.code === ErrorCode.IntegrityMismatch) rejected += 1;
    }
    const after = await collectMemory();
    const sample = {
      profile: PROFILE,
      attempts,
      rejected,
      materializeCalls,
      elapsedMs: Date.now() - startedAt,
      ...memoryDelta(before, after),
    };
    process.stdout.write(`P17_CATALOG_SOAK_SAMPLE ${JSON.stringify(sample)}\n`);

    expect(sample).toMatchObject({ attempts, rejected: attempts, materializeCalls: attempts });
    expect(sample.heapDeltaBytes).toBeLessThan(32 * 1024 * 1024);
    expect(sample.rssDeltaBytes).toBeLessThan(64 * 1024 * 1024);
  });
});
