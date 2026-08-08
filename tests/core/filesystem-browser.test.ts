import {
  BrowseTokenStore,
  FilesystemBrowserService,
  type DirectoryIdentity,
  type DirectoryRead,
  type FilesystemBrowserPort,
} from "@vidcom/core";
import { ErrorCode } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

const SESSION = "session_a";

function identityFor(canonicalPath: string): DirectoryIdentity {
  return { device: "1", inode: canonicalPath };
}

/** An in-memory tree. No `node:fs` anywhere: policy is what is under test. */
function port(tree: Record<string, DirectoryRead>, overrides: Partial<FilesystemBrowserPort> = {}) {
  const moved = new Set<string>();
  const implementation: FilesystemBrowserPort = {
    roots: async () => [{ displayPath: "/", canonicalPath: "/", identity: identityFor("/") }],
    read: async (canonicalPath) => tree[canonicalPath] ?? { ok: false, reason: "not-found" },
    identity: async (canonicalPath) => {
      if (moved.has(canonicalPath)) return { device: "1", inode: "replaced" };
      return tree[canonicalPath] ? identityFor(canonicalPath) : undefined;
    },
    join: async (canonicalPath, name) => `${canonicalPath === "/" ? "" : canonicalPath}/${name}`,
    createDirectory: async () => ({ ok: true, entries: [], identity: identityFor("/new") }),
    ...overrides,
  };
  return { implementation, moved };
}

function service(tree: Record<string, DirectoryRead>, overrides?: Partial<FilesystemBrowserPort>) {
  const built = port(tree, overrides);
  const tokens = new BrowseTokenStore();
  return {
    ...built,
    tokens,
    instance: new FilesystemBrowserService(built.implementation, tokens),
  };
}

function directory(names: readonly (readonly [string, boolean])[]): DirectoryRead {
  return {
    ok: true,
    identity: identityFor("/"),
    entries: names.map(([name, isDirectory]) => ({ name, isDirectory, isSymbolicLink: false })),
  };
}

describe("filesystem browser policy", () => {
  it("mints a token per root and never returns a bare path to spend", async () => {
    const value = service({ "/": directory([]) });
    const roots = await value.instance.roots(SESSION);

    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.value[0]?.displayPath).toBe("/");
    expect(roots.value[0]?.token).toMatch(/^browse_/u);
  });

  it("gives directories a token and files only a name", async () => {
    const value = service({
      "/": directory([["projects", true], ["notes.txt", false]]),
      "/projects": directory([]),
    });
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    const page = await value.instance.list({ sessionId: SESSION, token: roots.value[0]!.token });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // A file with a handle invites being used as a destination.
    expect(page.value.entries).toEqual([
      { name: "notes.txt", isDirectory: false },
      { name: "projects", isDirectory: true, token: expect.stringMatching(/^browse_/u) },
    ]);
  });

  it("pages a large directory instead of returning all of it", async () => {
    const many = Array.from({ length: 1_200 }, (_unused, index) =>
      [`entry-${String(index).padStart(4, "0")}`, false] as const);
    const value = service({ "/": directory(many) });
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    const first = await value.instance.list({
      sessionId: SESSION, token: roots.value[0]!.token, pageSize: 500,
    });
    if (!first.ok) return;
    expect(first.value.entries).toHaveLength(500);
    expect(first.value.cursor).toBe("500");

    const last = await value.instance.list({
      sessionId: SESSION, token: roots.value[0]!.token, cursor: "1000", pageSize: 500,
    });
    if (!last.ok) return;
    expect(last.value.entries).toHaveLength(200);
    // No cursor means no more pages, which is how a caller knows to stop.
    expect(last.value.cursor).toBeUndefined();
  });

  it("caps an oversized page size rather than honouring it", async () => {
    const many = Array.from({ length: 2_000 }, (_unused, index) => [`e${index}`, false] as const);
    const value = service({ "/": directory(many) });
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    const page = await value.instance.list({
      sessionId: SESSION, token: roots.value[0]!.token, pageSize: 100_000,
    });
    if (!page.ok) return;
    expect(page.value.entries.length).toBeLessThanOrEqual(1_000);
  });

  it.each([
    ["not-found", ErrorCode.NotFound],
    ["not-a-directory", ErrorCode.PathInvalid],
    ["permission-denied", ErrorCode.PathPermissionDenied],
    ["timeout", ErrorCode.PathTimeout],
  ] as const)("maps a %s read to its own code, never a fault", async (reason, code) => {
    const value = service(
      { "/": directory([]) },
      { read: async () => ({ ok: false, reason }) },
    );
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    const page = await value.instance.list({ sessionId: SESSION, token: roots.value[0]!.token });
    expect(page.ok).toBe(false);
    if (page.ok) return;
    // Being refused or kept waiting by the user's own filesystem is an answer.
    expect(page.error.code).toBe(code);
  });

  it("refuses a token belonging to another session", async () => {
    const value = service({ "/": directory([]) });
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    const page = await value.instance.list({ sessionId: "session_b", token: roots.value[0]!.token });
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.error.code).toBe(ErrorCode.BrowseTokenInvalid);
  });

  it("invalidates a token once the directory it named has been replaced", async () => {
    const value = service({ "/": directory([]) });
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    value.moved.add("/");
    const page = await value.instance.list({ sessionId: SESSION, token: roots.value[0]!.token });
    expect(page.ok).toBe(false);
    if (page.ok) return;
    // Identity is compared at use time, so a swapped directory fails rather
    // than quietly redirecting the browse somewhere else.
    expect(page.error.code).toBe(ErrorCode.BrowseTokenInvalid);
  });

  it.each(["", "..", ".", "a/b", "a\\b"])("refuses %s as a new directory name", async (name) => {
    const value = service({ "/": directory([]) });
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    const created = await value.instance.createDirectory({
      sessionId: SESSION, parentToken: roots.value[0]!.token, name,
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe(ErrorCode.PathInvalid);
  });

  it("returns the absolute path only through a valid selection token", async () => {
    const value = service({ "/": directory([]) });
    const roots = await value.instance.roots(SESSION);
    if (!roots.ok) return;

    const resolved = await value.instance.resolveSelection({
      sessionId: SESSION, token: roots.value[0]!.token,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toBe("/");

    expect((await value.instance.resolveSelection({
      sessionId: SESSION, token: "browse_forged",
    })).ok).toBe(false);
  });
});
