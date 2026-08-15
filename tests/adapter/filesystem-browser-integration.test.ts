import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowseWorkerPool, WorkerFilesystemBrowser } from "@vidcom/adapter";
import { BrowseTokenStore, FilesystemBrowserService } from "@vidcom/core";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

const SESSION = "session_a";
const POSIX = process.platform !== "win32";
const roots: string[] = [];
const browsers: WorkerFilesystemBrowser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-fs-browse-")));
  roots.push(root);
  return root;
}

function browser(timeoutMs = 20_000) {
  const created = new WorkerFilesystemBrowser(new BrowseWorkerPool(2, timeoutMs));
  browsers.push(created);
  return created;
}

function service(instance: WorkerFilesystemBrowser) {
  return new FilesystemBrowserService(instance, new BrowseTokenStore());
}

/** Mints a token for a real directory, the way a browse would. */
async function tokenFor(instance: WorkerFilesystemBrowser, tokens: BrowseTokenStore, target: string) {
  const identity = await instance.identity(target);
  if (!identity) throw new Error(`no identity for ${target}`);
  return tokens.mint({ sessionId: SESSION, canonicalPath: target, identity }).token;
}

describe("filesystem browsing on a real filesystem", () => {
  it("lists a real directory through the worker", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "projects"));
    await writeFile(path.join(root, "notes.txt"), "notes\n", "utf8");

    const instance = browser();
    const read = await instance.read(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.map((entry) => entry.name).sort()).toEqual(["notes.txt", "projects"]);
  });

  it("pages a directory with many entries instead of hanging", async () => {
    const root = await scratch();
    const big = path.join(root, "big");
    await mkdir(big);
    // 5,000 rather than 200,000: the property under test is that paging bounds
    // the response, and it holds at any size a test can create in seconds.
    await Promise.all(Array.from({ length: 5_000 }, (_unused, index) =>
      writeFile(path.join(big, `entry-${String(index).padStart(5, "0")}`), "", "utf8")));

    const instance = browser();
    const tokens = new BrowseTokenStore();
    const page = await new FilesystemBrowserService(instance, tokens).list({
      sessionId: SESSION,
      token: await tokenFor(instance, tokens, big),
      pageSize: 500,
    });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.entries).toHaveLength(500);
    expect(page.value.cursor).toBe("500");
  });

  it.skipIf(!POSIX)("reports permission denied as a code, never a fault", async () => {
    const root = await scratch();
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await writeFile(path.join(locked, "secret.txt"), "secret\n", "utf8");
    await chmod(locked, 0o000);

    try {
      const read = await browser().read(locked);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      // Being refused by the user's own operating system is an answer.
      expect(read.reason).toBe("permission-denied");
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("reports a missing directory rather than throwing", async () => {
    const read = await browser().read(path.join(await scratch(), "absent"));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("not-found");
  });

  it("reports a file where a directory was expected", async () => {
    const root = await scratch();
    const file = path.join(root, "notes.txt");
    await writeFile(file, "notes\n", "utf8");

    const read = await browser().read(file);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("not-a-directory");
  });

  it.skipIf(!POSIX)("invalidates a token when a symlink is repointed between requests", async () => {
    const root = await scratch();
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const link = path.join(root, "current");
    await Promise.all([mkdir(first), mkdir(second)]);
    await symlink(first, link);

    const instance = browser();
    const tokens = new BrowseTokenStore();
    const browse = new FilesystemBrowserService(instance, tokens);
    const token = await tokenFor(instance, tokens, link);
    expect((await browse.list({ sessionId: SESSION, token })).ok).toBe(true);

    // The classic TOCTOU: same path string, different directory.
    await unlink(link);
    await symlink(second, link);

    const after = await browse.list({ sessionId: SESSION, token });
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error.code).toBe(ErrorCode.BrowseTokenInvalid);
  });

  it("creates a directory and hands back a token for it", async () => {
    const root = await scratch();
    const instance = browser();
    const tokens = new BrowseTokenStore();
    const browse = new FilesystemBrowserService(instance, tokens);

    const created = await browse.createDirectory({
      sessionId: SESSION,
      parentToken: await tokenFor(instance, tokens, root),
      name: "new-project",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listed = await browse.list({ sessionId: SESSION, token: created.value.token! });
    expect(listed.ok).toBe(true);
  });

  it("offers at least one root that can actually be listed", async () => {
    const instance = browser();
    const roots = await instance.roots();

    expect(roots.length).toBeGreaterThan(0);
    // Windows enumerates drive letters by probing them; a root that cannot be
    // read has no business being offered as a starting point.
    const read = await instance.read(roots[0]!.canonicalPath);
    expect(read.ok).toBe(true);
  });
});
