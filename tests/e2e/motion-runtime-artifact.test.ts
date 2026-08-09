import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FilesystemRuntimeAssetSource,
  resolveRuntimePaths,
  RuntimeAssetManager,
} from "@vidcom/adapter";
import { createMcpRegistry, startVidcomFoundation } from "@vidcom/cli";
import {
  InstallMotionLibraryOutputSchema,
  MOTION_LIBRARIES,
} from "@vidcom/contracts";
import { PLATFORM_PRESETS, type AbsolutePath } from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRuntimeArchives,
  loadExpectedPythonPackages,
} from "../../scripts/build-runtime-archives.mjs";
import { createSequentialIdPort } from "../support/deterministic";
import { HOST_SUPPORTED, HOST_TAG } from "../support/runtime-fixture";

// The catalogue packages are dependencies of @vidcom/adapter, not of the test
// workspace. Resolve only while staging the archive from that owning package.
const requireFromAdapter = createRequire(new URL("../../packages/adapter/package.json", import.meta.url));
const roots: string[] = [];
const INTEGRATION_TIMEOUT_MS = 120_000;

interface StagedLibrary {
  manifest: Buffer;
  files: ReadonlyMap<string, Buffer>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-motion-runtime-")));
  roots.push(root);
  return root;
}

function installedPackageRoot(packageName: string): string {
  let directory = path.dirname(requireFromAdapter.resolve(packageName));
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
      if (parsed.name === packageName) return directory;
    } catch {
      // An entry point may be several directories below its package manifest.
    }
    directory = path.dirname(directory);
  }
  throw new Error(`installed package root was not found for ${packageName}`);
}

async function stageHyperframesRuntime(
  root: string,
): Promise<Map<string, StagedLibrary>> {
  const hyperframesRoot = path.join(root, "sources", "hyperframes");
  await mkdir(path.join(hyperframesRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(hyperframesRoot, "package.json"),
    `${JSON.stringify({ name: "hyperframes", version: "1.0.0" })}\n`,
    "utf8",
  );
  await writeFile(path.join(hyperframesRoot, "bin", "hyperframes.mjs"), "export {};\n", "utf8");

  const staged = new Map<string, StagedLibrary>();
  for (const library of MOTION_LIBRARIES) {
    const installedRoot = installedPackageRoot(library.packageName);
    const destinationRoot = path.join(hyperframesRoot, "motion-libraries", library.packageName);
    const manifest = await readFile(path.join(installedRoot, "package.json"));
    const parsed = JSON.parse(manifest.toString("utf8")) as { version?: unknown };
    expect(parsed.version, library.packageName).toBe(library.version);
    await mkdir(destinationRoot, { recursive: true });
    await copyFile(path.join(installedRoot, "package.json"), path.join(destinationRoot, "package.json"));

    const files = new Map<string, Buffer>();
    for (const declared of library.files) {
      const source = path.join(installedRoot, declared.packagePath);
      const destination = path.join(destinationRoot, declared.packagePath);
      const bytes = await readFile(source);
      files.set(declared.packagePath, bytes);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    staged.set(library.id, { manifest, files });
  }
  return staged;
}

async function buildArtifactRuntime(root: string): Promise<{
  outputRoot: string;
  staged: Map<string, StagedLibrary>;
}> {
  const staged = await stageHyperframesRuntime(root);
  const nodeRoot = path.join(root, "sources", "node", "bin");
  await mkdir(nodeRoot, { recursive: true });
  await writeFile(path.join(nodeRoot, "node-runtime.txt"), "artifact runtime fixture\n", "utf8");

  const expected = await loadExpectedPythonPackages();
  const pins = expected[HOST_TAG];
  if (!pins) throw new Error(`Python package evidence is unavailable for ${HOST_TAG}`);
  await writeFile(path.join(root, "packages.txt"), `${pins.join("\n")}\n`, "utf8");

  const configFile = path.join(root, "runtime-archives.json");
  await writeFile(configFile, `${JSON.stringify({
    artifactVersion: "motion-integration-1",
    versions: {
      node: process.version.slice(1),
      hyperframes: "1.0.0",
      esbuild: "0.25.0",
      ffmpeg: "7.1",
      cpython: "3.12.7",
      vieneu: "1.0.0",
      motion: Object.fromEntries(MOTION_LIBRARIES.map((library) => [library.packageName, library.version])),
    },
    pythonPackages: { [HOST_TAG]: "./packages.txt" },
    archives: [
      { key: "hyperframes", platform: HOST_TAG, source: "./sources/hyperframes", target: "hyperframes" },
      { key: "node", platform: HOST_TAG, source: "./sources/node", target: "node" },
    ],
  }, null, 2)}\n`, "utf8");

  const outputRoot = path.join(root, "built-runtime");
  const manifest = await buildRuntimeArchives({ configFile, outputRoot });
  expect(manifest.archives.map(({ key }) => key).sort()).toEqual(["hyperframes", "node"]);
  // Extraction below must consume the built archives, never the staging tree.
  await rm(path.join(root, "sources"), { recursive: true });
  return { outputRoot, staged };
}

describe.skipIf(!HOST_SUPPORTED)("packaged motion-library runtime", () => {
  it("builds, extracts and vendors every pinned library through the real tool authority", async () => {
    expect(MOTION_LIBRARIES.map(({ id }) => id)).toEqual([
      "gsap",
      "anime",
      "motion-one",
      "lottie",
      "three",
    ]);
    const root = await temporaryRoot();
    const appDataRoot = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const { outputRoot, staged } = await buildArtifactRuntime(root);
    const installation = await new RuntimeAssetManager({
      appDataRoot,
      source: new FilesystemRuntimeAssetSource(outputRoot),
    }).ensureAll();
    const runtimePaths = resolveRuntimePaths({
      mode: "artifact",
      versionRoot: installation.versionRoot,
      archiveRoots: installation.archiveRoots,
      appDataRoot,
    });

    for (const library of MOTION_LIBRARIES) {
      const expected = staged.get(library.id);
      if (!expected) throw new Error(`staged bytes are unavailable for ${library.id}`);
      const extractedRoot = path.join(runtimePaths.motionLibraryRoot, library.packageName);
      expect(await readFile(path.join(extractedRoot, "package.json"))).toEqual(expected.manifest);
      for (const declared of library.files) {
        expect(await readFile(path.join(extractedRoot, declared.packagePath)))
          .toEqual(expected.files.get(declared.packagePath));
      }
    }

    const foundation = await startVidcomFoundation({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
      runtimePaths,
      holderId: "test:motion-runtime-artifact",
      clock: { now: () => new Date("2026-08-09T00:00:00.000Z") },
      ids: createSequentialIdPort(),
    }, {
      async recoverJobs() {},
      async startScheduler() {},
      async startWatcher() {},
      async openListener() { return null; },
    });
    try {
      const created = await foundation.application.lifecycle.create({
        name: "Artifact Motion Libraries",
        preset: PLATFORM_PRESETS[0]!,
      });
      if (!created.ok) throw new Error(created.error.message);
      const projectRoot = path.join(workspaceRoot, created.value.slug);
      const registry = createMcpRegistry(foundation.infrastructure, foundation.application);
      const request = {
        era: "modern" as const,
        protocolVersion: "2025-06-18",
        credentialId: "test-motion-runtime",
        requestInput: async (): Promise<never> => { throw new Error("input not expected"); },
      };

      for (const library of MOTION_LIBRARIES) {
        const invoked = await registry.invoke("install_motion_library", {
          projectId: created.value.projectId,
          libraryId: library.id,
        }, request);
        expect(invoked, library.id).toMatchObject({ ok: true });
        if (!invoked.ok) throw new Error(invoked.error.message);
        const output = InstallMotionLibraryOutputSchema.parse(invoked.value);
        expect(output).toMatchObject({
          status: "installed",
          library: { id: library.id, version: library.version },
        });
        const expected = staged.get(library.id);
        if (!expected) throw new Error(`staged bytes are unavailable for ${library.id}`);
        for (const declared of library.files) {
          expect(await readFile(path.join(projectRoot, declared.projectPath)))
            .toEqual(expected.files.get(declared.packagePath));
        }
      }

      // Make the explicit artifact root unavailable. A hidden fallback to the
      // checkout's node_modules would turn this into already_installed instead
      // of the distribution error required by the packaged path.
      const unavailable = `${runtimePaths.motionLibraryRoot}.unavailable`;
      await rename(runtimePaths.motionLibraryRoot, unavailable);
      const noFallback = await registry.invoke("install_motion_library", {
        projectId: created.value.projectId,
        libraryId: MOTION_LIBRARIES[0]!.id,
      }, request);
      expect(noFallback).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
    } finally {
      await foundation.stop();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
