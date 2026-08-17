import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JournalId, ResolvedPath } from "@vidcom/core";
import { captureForMutation } from "../../packages/adapter/src/fs/mutation-capture";

const roots: string[] = [];
const journalId = 1 as JournalId;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-directory-capture-"));
  roots.push(root);
  return root;
}

describe("directory mutation capture", () => {
  it("records an existing directory without moving or reading it as bytes", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "assets") as ResolvedPath;
    await mkdir(target);

    const captured = await captureForMutation(
      target,
      { kind: "directory", existedBefore: true },
      journalId,
      0,
    );

    expect(captured).toMatchObject({
      ok: true,
      value: {
        kind: "directory",
        target,
        rollbackPath: null,
        capturedHash: null,
        existedBefore: true,
      },
    });
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("records an absent directory and rejects a file collision", async () => {
    const root = await temporaryRoot();
    const absent = path.join(root, "new-folder") as ResolvedPath;
    await expect(captureForMutation(
      absent,
      { kind: "directory", existedBefore: false },
      journalId,
      0,
    )).resolves.toMatchObject({ ok: true, value: { kind: "directory", existedBefore: false } });

    const file = path.join(root, "collision") as ResolvedPath;
    await writeFile(file, "not a directory");
    await expect(captureForMutation(
      file,
      { kind: "directory", existedBefore: true },
      journalId,
      1,
    )).resolves.toEqual({ ok: false, error: { actualState: "file" } });
  });
});
