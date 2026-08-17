import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NODE_PTY_HELPER_PLATFORMS,
  nodePtyRoot,
  normalizeNodePtyHelpers,
} from "../../scripts/normalize-node-pty-helper.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prebuildTree(modes: Partial<Record<string, number>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-node-pty-"));
  roots.push(root);
  for (const [platform, mode] of Object.entries(modes)) {
    const directory = path.join(root, "prebuilds", platform);
    await mkdir(directory, { recursive: true });
    const helper = path.join(directory, "spawn-helper");
    await writeFile(helper, "helper", "utf8");
    await chmod(helper, mode ?? 0o644);
  }
  return root;
}

async function isExecutable(filename: string): Promise<boolean> {
  return ((await lstat(filename)).mode & 0o111) !== 0;
}

describe("node-pty spawn helper", () => {
  it("restores the execute bit an install dropped", async () => {
    // Without it, every pty open on macOS fails with `posix_spawnp failed.` and
    // names neither the file nor a reason — the exact failure the macOS runner
    // reported while Linux and Windows, which fork instead, stayed green.
    const root = await prebuildTree({ "darwin-arm64": 0o644 });
    const normalized = await normalizeNodePtyHelpers(root);
    expect(normalized).toEqual([path.join(root, "prebuilds", "darwin-arm64", "spawn-helper")]);
    expect(await isExecutable(normalized[0])).toBe(true);
  });

  it("reports nothing when the helper already carries the bit", async () => {
    const root = await prebuildTree({ "darwin-arm64": 0o755 });
    expect(await normalizeNodePtyHelpers(root)).toEqual([]);
  });

  it("treats a prebuild this install does not carry as normal", async () => {
    // An install ships the prebuilds it needs. A missing directory is not a
    // broken install, and failing on it would make the check unusable on the
    // platforms that never spawn a helper at all.
    expect(await normalizeNodePtyHelpers(await prebuildTree({}))).toEqual([]);
  });

  it("refuses a helper that is not a regular file", async () => {
    const root = await prebuildTree({});
    await mkdir(path.join(root, "prebuilds", "darwin-arm64", "spawn-helper"), { recursive: true });
    await expect(normalizeNodePtyHelpers(root)).rejects.toThrow(/not a regular file/u);
  });

  it("resolves node-pty through the package that declares it", async () => {
    // Asking from the repository root finds nothing: the dependency belongs to
    // the adapter workspace rather than to the root manifest.
    const root = nodePtyRoot();
    expect(path.basename(root)).toBe("node-pty");
    expect(await lstat(path.join(root, "prebuilds")).then((entry) => entry.isDirectory())).toBe(true);
    expect(NODE_PTY_HELPER_PLATFORMS).toEqual(["darwin-arm64", "darwin-x64"]);
  });
});
