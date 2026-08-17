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

/**
 * Windows has no POSIX execute bit, so a fixture there cannot express either
 * side of this: `chmod` neither clears nor sets it, and the defect being
 * regressed against — a helper installed without the bit — has no meaning on a
 * platform where node-pty talks to ConPTY and spawns no helper at all. Skipped
 * with the reason rather than asserted differently, so a run on Windows says so.
 */
const onPosix = it.skipIf(process.platform === "win32");

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
  onPosix("restores the execute bit an install dropped", async () => {
    // Without it, every pty open on macOS fails with `posix_spawnp failed.` and
    // names neither the file nor a reason — the exact failure the macOS runner
    // reported while Linux and Windows, which spawn no helper, stayed green.
    const root = await prebuildTree({ "darwin-arm64": 0o644 });
    const normalized = await normalizeNodePtyHelpers(root, "darwin");
    expect(normalized).toEqual([path.join(root, "prebuilds", "darwin-arm64", "spawn-helper")]);
    expect(await isExecutable(normalized[0])).toBe(true);
  });

  onPosix("reports nothing when the helper already carries the bit", async () => {
    const root = await prebuildTree({ "darwin-arm64": 0o755 });
    expect(await normalizeNodePtyHelpers(root, "darwin")).toEqual([]);
  });

  onPosix("refuses a helper that is not a regular file", async () => {
    const root = await prebuildTree({});
    await mkdir(path.join(root, "prebuilds", "darwin-arm64", "spawn-helper"), { recursive: true });
    await expect(normalizeNodePtyHelpers(root, "darwin")).rejects.toThrow(/not a regular file/u);
  });

  it("treats a prebuild this install does not carry as normal", async () => {
    // An install ships the prebuilds it needs. A missing directory is not a
    // broken install, and failing on it would make the check unusable on the
    // platforms that never spawn a helper at all.
    expect(await normalizeNodePtyHelpers(await prebuildTree({}), "darwin")).toEqual([]);
  });

  it("does nothing at all off Darwin, and does not read the tree to decide", async () => {
    // The requirement is Darwin's alone. Stating that inside the function keeps
    // every caller from having to know it — including a Windows run of a
    // fixture that could not express the bit anyway.
    const root = await prebuildTree({ "darwin-arm64": 0o644 });
    expect(await normalizeNodePtyHelpers(root, "win32")).toEqual([]);
    expect(await normalizeNodePtyHelpers(path.join(root, "absent"), "linux")).toEqual([]);
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
