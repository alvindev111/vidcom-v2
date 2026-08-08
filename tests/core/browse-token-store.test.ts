import { BROWSE_TOKEN_TTL_MS, BrowseTokenStore, type DirectoryIdentity } from "@vidcom/core";
import { ErrorCode } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

const IDENTITY: DirectoryIdentity = { device: "66306", inode: "1234" };
const MOVED: DirectoryIdentity = { device: "66306", inode: "9999" };

function store(now = { value: 0 }) {
  return {
    now,
    instance: new BrowseTokenStore({ now: () => now.value }),
  };
}

function mint(instance: BrowseTokenStore, sessionId = "session_a") {
  return instance.mint({ sessionId, canonicalPath: "/home/user/projects", identity: IDENTITY });
}

describe("browse token store", () => {
  it("resolves a token for the session that minted it", () => {
    const { instance } = store();
    const token = mint(instance);

    const resolved = instance.resolve({
      token: token.token, sessionId: "session_a", currentIdentity: IDENTITY,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.canonicalPath).toBe("/home/user/projects");
  });

  it("refuses a token spent by a different session", () => {
    const { instance } = store();
    const token = mint(instance, "session_a");

    const resolved = instance.resolve({
      token: token.token, sessionId: "session_b", currentIdentity: IDENTITY,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe(ErrorCode.BrowseTokenInvalid);
  });

  it("uses one code for absent, foreign and expired tokens alike", () => {
    const { now, instance } = store();
    const token = mint(instance);
    now.value = BROWSE_TOKEN_TTL_MS + 1;

    // Distinguishing them would tell a caller which tokens exist.
    for (const attempt of [
      { token: "browse_nope", sessionId: "session_a" },
      { token: token.token, sessionId: "session_b" },
      { token: token.token, sessionId: "session_a" },
    ]) {
      const resolved = instance.resolve({ ...attempt, currentIdentity: IDENTITY });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.error.code).toBe(ErrorCode.BrowseTokenInvalid);
    }
  });

  it("expires a token once its TTL has passed", () => {
    const { now, instance } = store();
    const token = mint(instance);

    now.value = BROWSE_TOKEN_TTL_MS - 1;
    expect(instance.resolve({ token: token.token, sessionId: "session_a", currentIdentity: IDENTITY }).ok)
      .toBe(true);
    now.value = BROWSE_TOKEN_TTL_MS;
    expect(instance.resolve({ token: token.token, sessionId: "session_a", currentIdentity: IDENTITY }).ok)
      .toBe(false);
  });

  it("invalidates a token when the directory has been replaced", () => {
    const { instance } = store();
    const token = mint(instance);

    // A symlink repointed between two requests: the path is the same string and
    // names something else. This is the TOCTOU the identity binding closes.
    const resolved = instance.resolve({
      token: token.token, sessionId: "session_a", currentIdentity: MOVED,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.message).toContain("changed");
  });

  it("invalidates a token when the directory is gone", () => {
    const { instance } = store();
    const token = mint(instance);

    expect(instance.resolve({
      token: token.token, sessionId: "session_a", currentIdentity: undefined,
    }).ok).toBe(false);
  });

  it("does not let a rejected token be retried once the path comes back", () => {
    const { instance } = store();
    const token = mint(instance);

    instance.resolve({ token: token.token, sessionId: "session_a", currentIdentity: MOVED });
    // The token was burned by the mismatch; restoring the directory must not
    // resurrect a handle that already pointed somewhere else.
    expect(instance.resolve({
      token: token.token, sessionId: "session_a", currentIdentity: IDENTITY,
    }).ok).toBe(false);
  });

  it("drops every token belonging to a session that ended", () => {
    const { instance } = store();
    const kept = mint(instance, "session_b");
    mint(instance, "session_a");
    mint(instance, "session_a");

    instance.revokeSession("session_a");

    expect(instance.size()).toBe(1);
    expect(instance.resolve({
      token: kept.token, sessionId: "session_b", currentIdentity: IDENTITY,
    }).ok).toBe(true);
  });

  it("stops counting tokens once they expire", () => {
    const { now, instance } = store();
    mint(instance);
    expect(instance.size()).toBe(1);

    now.value = BROWSE_TOKEN_TTL_MS;
    // Held in memory only, and not held forever: a handle that outlived its
    // session would be a path anyone could spend.
    expect(instance.size()).toBe(0);
  });
});
