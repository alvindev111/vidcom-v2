import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectPublishedRuntimeIntegrity,
  RuntimeAssetManager,
  type EmbeddedRuntimeManifest,
  type RuntimeAssetSource,
} from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

import {
  archiveFor,
  assetSource,
  HOST_SUPPORTED,
  runtimeManifest,
} from "../support/runtime-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vidcom-runtime-integrity-")));
  roots.push(root);
  return root;
}

function fixture(fileCount = 32): {
  manifest: EmbeddedRuntimeManifest;
  source: RuntimeAssetSource;
} {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `files/${String(index).padStart(3, "0")}.txt`,
    content: Buffer.from(`runtime integrity fixture ${String(index)}\n`, "utf8"),
  }));
  const node = archiveFor("node", files.slice(0, Math.ceil(files.length / 2)));
  const hyperframes = archiveFor("hyperframes", files.slice(Math.ceil(files.length / 2)));
  const manifest = runtimeManifest("integrity-parallel-1.0.0", [node.archive, hyperframes.archive]);
  return {
    manifest,
    source: assetSource(manifest, { node: node.bytes, hyperframes: hyperframes.bytes }),
  };
}

async function installed(fileCount = 32) {
  const appDataRoot = await temporaryRoot();
  const value = fixture(fileCount);
  const installation = await new RuntimeAssetManager({
    appDataRoot,
    source: value.source,
  }).ensureAll();
  return {
    manifest: value.manifest,
    versionRoot: installation.versionRoot,
    archiveRoots: installation.archiveRoots,
  };
}

describe.skipIf(!HOST_SUPPORTED)("bounded runtime integrity hashing", () => {
  it("uses the default eight-file bound across archives", async () => {
    const installation = await installed(48);
    let active = 0;
    let maximum = 0;

    const inspection = await inspectPublishedRuntimeIntegrity(
      installation,
      process.platform,
      process.arch,
      {
        hooks: {
          async hashStarted() {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
          },
          hashFinished() {
            active -= 1;
          },
        },
      },
    );

    expect(inspection).toEqual({ ok: true, archives: 2, files: 48 });
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
  });

  it("returns the first archive/path issue even when later hashes finish first", async () => {
    const installation = await installed(8);
    const nodeRoot = installation.archiveRoots.node;
    const hyperframesRoot = installation.archiveRoots.hyperframes;
    if (!nodeRoot || !hyperframesRoot) throw new Error("runtime fixture roots are missing");
    await writeFile(path.join(nodeRoot, "files/000.txt"), "first tamper", "utf8");
    await writeFile(path.join(hyperframesRoot, "files/004.txt"), "later tamper", "utf8");

    const inspection = await inspectPublishedRuntimeIntegrity(
      installation,
      process.platform,
      process.arch,
      {
        hashConcurrency: 8,
        hooks: {
          async hashStarted(pathname) {
            await new Promise((resolve) => setTimeout(
              resolve,
              path.basename(pathname) === "000.txt" ? 25 : 1,
            ));
          },
        },
      },
    );

    expect(inspection).toMatchObject({
      ok: false,
      issue: {
        archiveKey: "node",
        path: "files/000.txt",
        reason: "checksum_mismatch",
      },
    });
  });

  it("rejects hash bounds that could exhaust descriptors or disable verification", async () => {
    const installation = await installed(2);
    await expect(inspectPublishedRuntimeIntegrity(
      installation,
      process.platform,
      process.arch,
      { hashConcurrency: 0 },
    )).rejects.toThrow("between 1 and 32");
    await expect(inspectPublishedRuntimeIntegrity(
      installation,
      process.platform,
      process.arch,
      { hashConcurrency: 33 },
    )).rejects.toThrow("between 1 and 32");
  });
});
