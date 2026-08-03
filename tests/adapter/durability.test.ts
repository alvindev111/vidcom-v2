import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncDirectory } from "@vidcom/adapter";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-durability-"));
  roots.push(root);
  return root;
}

describe("directory durability across platforms", () => {
  it("skips the flush on Windows, where a directory handle cannot be synced", async () => {
    // Asserted by injecting the platform rather than by running on Windows, so
    // the branch is covered on every CI leg.
    await expect(syncDirectory(await directory(), "win32")).resolves.toBeUndefined();
  });

  it("flushes the directory on POSIX platforms", async () => {
    const root = await directory();
    const flushed = syncDirectory(root, "linux");
    if (process.platform === "win32") {
      // Proof the POSIX branch really issues the fsync: the same call that
      // resolves under the win32 branch above must reach the syscall here, and
      // Windows rejects it. On POSIX the syscall simply succeeds.
      await expect(flushed).rejects.toMatchObject({ syscall: "fsync" });
    } else {
      await expect(flushed).resolves.toBeUndefined();
    }
  });

  it("defaults to the running platform when none is injected", async () => {
    await expect(syncDirectory(await directory())).resolves.toBeUndefined();
  });
});
