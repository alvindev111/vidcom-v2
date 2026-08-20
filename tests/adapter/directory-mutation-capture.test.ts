import { access, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ContentHash } from "@vidcom/contracts";
import type { JournalId, ResolvedPath } from "@vidcom/core";
import { captureForMutation } from "../../packages/adapter/src/fs/mutation-capture";

const roots: string[] = [];
const journalId = 1 as JournalId;
const staleHash = `sha256:${"0".repeat(64)}` as ContentHash;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-directory-capture-"));
  roots.push(root);
  return root;
}

async function absent(pathname: string): Promise<boolean> {
  try { await access(pathname); return false; }
  catch { return true; }
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

  it.each([
    ["expected file becomes a directory", "expected" as const],
    ["expected-absent target becomes a directory", "absent" as const],
  ])("restores the visible entry when %s", async (_label, expectationKind) => {
    const root = await temporaryRoot();
    const target = path.join(root, "entry") as ResolvedPath;
    const rollback = path.join(root, ".entry.vidcom-1-0.rollback");
    await mkdir(target);

    const captured = await captureForMutation(
      target,
      expectationKind === "expected" ? staleHash : null,
      journalId,
      0,
    );

    expect(captured).toEqual({ ok: false, error: { actualState: "directory" } });
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await absent(rollback)).toBe(true);
  });

  it("restores a symlink entry without touching its internal target", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source.html");
    const target = path.join(root, "alias.html") as ResolvedPath;
    const rollback = path.join(root, ".alias.html.vidcom-1-0.rollback");
    await writeFile(source, "source");
    await symlink("source.html", target);

    const captured = await captureForMutation(
      target,
      staleHash,
      journalId,
      0,
    );

    expect(captured).toEqual({ ok: false, error: { actualState: "other" } });
    expect(await readlink(target)).toBe("source.html");
    expect(await readFile(source, "utf8")).toBe("source");
    expect(await absent(rollback)).toBe(true);
  });

  it("restores the entry after an injected post-rename hash failure", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "index.html") as ResolvedPath;
    const rollback = path.join(root, ".index.html.vidcom-1-0.rollback");
    await writeFile(target, "original");

    await expect(captureForMutation(
      target,
      staleHash,
      journalId,
      0,
      {},
      { async hashFile() { throw new Error("injected hash failure"); } },
    )).rejects.toThrow("injected hash failure");
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await absent(rollback)).toBe(true);
  });

  it("keeps journal ownership when a replacement appears before local restoration", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "entry") as ResolvedPath;
    const rollback = path.join(root, ".entry.vidcom-1-0.rollback") as ResolvedPath;
    await mkdir(target);

    const captured = await captureForMutation(
      target,
      staleHash,
      journalId,
      0,
      {},
      { async afterRename() { await writeFile(target, "replacement"); } },
    );

    expect(captured).toEqual({
      ok: false,
      error: {
        reason: "recovery_required",
        actualState: "directory",
        capture: { journalId, ordinal: 0, target, rollbackPath: rollback, capturedHash: null },
      },
    });
    expect(await readFile(target, "utf8")).toBe("replacement");
    expect((await stat(rollback)).isDirectory()).toBe(true);
  });
});
