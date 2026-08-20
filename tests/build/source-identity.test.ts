// @vitest-environment node

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
const script = path.resolve("scripts/source-identity.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Identity Test", GIT_AUTHOR_EMAIL: "identity@example.com",
      GIT_COMMITTER_NAME: "Identity Test", GIT_COMMITTER_EMAIL: "identity@example.com",
    },
  });
  return stdout;
}

/** A repository with one commit, and the script beside it so it can be run there. */
async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-identity-"));
  roots.push(root);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await run("cp", [script, path.join(root, "scripts", "source-identity.mjs")]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "one.ts"), "export const one = 1;\n");
  await writeFile(path.join(root, "src", "two.ts"), "export const two = 2;\n");
  await git(root, "init", "--quiet");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "base");
  return root;
}

async function identity(root: string): Promise<{ head: string; digest: string; paths: string[] }> {
  const { stdout } = await run("node", [path.join(root, "scripts", "source-identity.mjs"), "--json"], { cwd: root });
  return JSON.parse(stdout) as { head: string; digest: string; paths: string[] };
}

describe("source identity", () => {
  it("is the same whether a change is staged or not", async () => {
    const root = await repository();
    const clean = await identity(root);
    expect(clean.paths).toEqual([]);

    await writeFile(path.join(root, "src", "one.ts"), "export const one = 11;\n");
    const unstaged = await identity(root);
    expect(unstaged.paths).toEqual(["src/one.ts"]);
    expect(unstaged.digest).not.toBe(clean.digest);

    // Staging is bookkeeping, not a change to the source.
    await git(root, "add", "src/one.ts");
    expect(await identity(root)).toEqual(unstaged);
  });

  it("counts a file nobody has added yet", async () => {
    const root = await repository();
    const before = await identity(root);
    await writeFile(path.join(root, "src", "three.ts"), "export const three = 3;\n");
    const after = await identity(root);
    expect(after.paths).toEqual(["src/three.ts"]);
    expect(after.digest).not.toBe(before.digest);
  });

  it("distinguishes a deleted file from one that was never there", async () => {
    const root = await repository();
    const before = await identity(root);
    await unlink(path.join(root, "src", "two.ts"));
    const deleted = await identity(root);
    expect(deleted.paths).toEqual(["src/two.ts"]);
    expect(deleted.digest).not.toBe(before.digest);

    // Restoring the exact bytes restores the exact identity.
    await writeFile(path.join(root, "src", "two.ts"), "export const two = 2;\n");
    expect((await identity(root)).digest).toBe(before.digest);
  });

  it("hashes a symlink's target rather than what it points at", async () => {
    const root = await repository();
    await writeFile(path.join(root, "src", "secret.ts"), "export const secret = 1;\n");
    await git(root, "add", "src/secret.ts");
    await git(root, "commit", "--quiet", "-m", "secret");
    const before = await identity(root);

    await symlink("secret.ts", path.join(root, "src", "link.ts"));
    const linked = await identity(root);
    expect(linked.paths).toEqual(["src/link.ts"]);

    // Changing the file the link points at does not change the link's own record,
    // and following it would have hashed content that is already counted once.
    await writeFile(path.join(root, "src", "secret.ts"), "export const secret = 2;\n");
    const both = await identity(root);
    expect(both.paths).toEqual(["src/link.ts", "src/secret.ts"]);
    expect(both.digest).not.toBe(linked.digest);
    expect(before.digest).not.toBe(linked.digest);
  });

  // Windows has no executable bit for Git to notice, so this case is only
  // meaningful where the filesystem actually carries one.
  it.runIf(process.platform !== "win32")("notices a mode change on its own", async () => {
    const root = await repository();
    const before = await identity(root);
    await chmod(path.join(root, "src", "one.ts"), 0o755);
    const executable = await identity(root);
    expect(executable.paths).toEqual(["src/one.ts"]);
    expect(executable.digest).not.toBe(before.digest);
  });

  it("ignores only this spec's own evidence files", async () => {
    const root = await repository();
    const specDirectory = path.join(
      root, "llm-documents", "specs-and-process", "specs", "spec-editing-experience",
    );
    await mkdir(specDirectory, { recursive: true });
    const before = await identity(root);

    for (const name of [
      "spec-editing-experience-implementation-checklist.md",
      "implementation-notes.html",
      "spec-editing-experience-complete.md",
    ]) {
      await writeFile(path.join(specDirectory, name), "recorded evidence\n");
    }
    expect(await identity(root)).toEqual(before);

    // The design document beside them is source, and does change the identity.
    await writeFile(path.join(specDirectory, "spec-editing-experience-detailed-design.md"), "design\n");
    const withDesign = await identity(root);
    expect(withDesign.digest).not.toBe(before.digest);
    expect(withDesign.paths).toContain(
      "llm-documents/specs-and-process/specs/spec-editing-experience/spec-editing-experience-detailed-design.md",
    );
  });

  it("cannot be confused by a path that looks like two paths joined", async () => {
    const root = await repository();
    await mkdir(path.join(root, "src", "a"), { recursive: true });
    await writeFile(path.join(root, "src", "a", "b.ts"), "export const b = 1;\n");
    const nested = await identity(root);

    await rm(path.join(root, "src", "a"), { recursive: true, force: true });
    await writeFile(path.join(root, "src", "ab.ts"), "export const b = 1;\n");
    const flat = await identity(root);
    expect(flat.digest).not.toBe(nested.digest);
  });
});
