import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BridgeCredentialStore,
  secureAppDataDirectorySync,
  secureCredentialFile,
  systemTool,
} from "@vidcom/adapter";
import {
  bindLoopback,
  createServerApp,
  InMemoryNonceStore,
  InMemorySessionStore,
  LoopbackBindError,
  noncePolicy,
  SESSION_COOKIE,
  sessionPolicy,
} from "@vidcom/server";
import { afterEach, describe, expect, it } from "vitest";

import { hasPosixFileModes } from "../support/platform";

function mutableClock(initial = Date.parse("2026-08-01T00:00:00.000Z")) {
  let now = initial;
  return {
    now: () => new Date(now),
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

function deterministicRandom(fill: number) {
  return (size: number) => Buffer.alloc(size, fill);
}

function appFixture(options: { trace?: string[]; logs?: string[] } = {}) {
  const port = 43123;
  const clock = mutableClock();
  const nonces = new InMemoryNonceStore(clock, deterministicRandom(0x11));
  const sessions = new InMemorySessionStore(clock, deterministicRandom(0x22));
  const app = createServerApp({
    port,
    uiOrigins: ["http://127.0.0.1:3000"],
    nonces,
    sessions,
    log: (line) => options.logs?.push(line),
    trace: (step) => options.trace?.push(step),
  });
  return { app, clock, nonces, sessions, base: `http://127.0.0.1:${port}` };
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("expected session cookie");
  return value.split(";", 1)[0]!;
}

async function exchange(fixture: ReturnType<typeof appFixture>, nonce: string) {
  return localRequest(fixture, "/api/v1/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
}

function localRequest(
  fixture: ReturnType<typeof appFixture>,
  pathname: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (!headers.has("Host")) headers.set("Host", new URL(fixture.base).host);
  return fixture.app.request(`${fixture.base}${pathname}`, { ...init, headers });
}

describe("Hono security perimeter", () => {
  it("runs the fixed middleware, validation, route and error mapping order", async () => {
    const trace: string[] = [];
    const fixture = appFixture({ trace });
    const response = await exchange(fixture, fixture.nonces.issue());

    expect(response.status).toBe(204);
    expect(trace).toEqual([
      "requestId", "logger", "hostCheck", "cors", "auth", "bodyLimit", "validate", "route",
    ]);

    trace.length = 0;
    const invalid = await exchange(fixture, "not-issued");
    expect(invalid.status).toBe(401);
    expect(trace.at(-1)).toBe("errorMapper");
  });

  it("rejects a hostile Host before auth", async () => {
    const trace: string[] = [];
    const fixture = appFixture({ trace });
    const response = await localRequest(fixture, "/api/v1/health", {
      headers: { Host: "evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "host_not_allowed" } });
    expect(trace).toEqual(["requestId", "logger", "hostCheck", "errorMapper"]);
  });

  it("denies unlisted cross-origin requests without reflecting Origin", async () => {
    const fixture = appFixture();
    const response = await localRequest(fixture, "/api/v1/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "origin_not_allowed" } });
  });

  it("emits the canonical configured origin for credentialed preflight", async () => {
    const fixture = appFixture();
    const response = await localRequest(fixture, "/api/v1/health", {
      method: "OPTIONS",
      headers: {
        Origin: "HTTP://127.0.0.1:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");
    expect(response.headers.get("access-control-allow-origin")).not.toBe("HTTP://127.0.0.1:3000");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods"))
      .toBe("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers"))
      .toBe("Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name");
    expect(response.headers.get("vary"))
      .toBe("Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  });

  it("requires a session even for localhost and every non-exchange path", async () => {
    const fixture = appFixture();
    for (const pathname of ["/api/v1/health", "/api/v1/does-not-exist"]) {
      const response = await localRequest(fixture, pathname);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "auth_required" } });
    }
  });

  it("maps validation and body-size failures through the structured error boundary", async () => {
    const fixture = appFixture();
    const invalid = await localRequest(fixture, "/api/v1/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: true }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "schema_invalid" } });

    const tooLarge = await localRequest(fixture, "/api/v1/auth/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(1_048_577),
      },
      body: JSON.stringify({ nonce: "x" }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: "too_large" } });
  });

  it("consumes a 32-byte nonce once before minting a distinct 32-byte session", async () => {
    const fixture = appFixture();
    const nonce = fixture.nonces.issue();
    expect(Buffer.from(nonce, "base64url")).toHaveLength(noncePolicy.bytes);

    const first = await exchange(fixture, nonce);
    const cookie = cookieFrom(first);
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    expect(first.status).toBe(204);
    expect(token).not.toBe(nonce);
    expect(Buffer.from(token, "base64url")).toHaveLength(sessionPolicy.bytes);
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("set-cookie")).toContain("HttpOnly");
    expect(first.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(fixture.sessions.storedHashes()).toHaveLength(1);
    expect(fixture.sessions.storedHashes()).not.toContain(token);

    const second = await exchange(fixture, nonce);
    expect(second.status).toBe(401);
    expect(await second.json()).toMatchObject({ error: { code: "auth_nonce_invalid" } });
  });

  it("expires nonce, idle sessions and absolute sessions at their exact TTL", async () => {
    const nonceFixture = appFixture();
    const nonce = nonceFixture.nonces.issue();
    nonceFixture.clock.advance(noncePolicy.ttlMs);
    expect((await exchange(nonceFixture, nonce)).status).toBe(401);

    const idleFixture = appFixture();
    const idleCookie = cookieFrom(await exchange(idleFixture, idleFixture.nonces.issue()));
    idleFixture.clock.advance(sessionPolicy.idleTtlMs);
    expect((await localRequest(idleFixture, "/api/v1/health", {
      headers: { Cookie: idleCookie },
    })).status).toBe(401);

    const absoluteFixture = appFixture();
    const absoluteCookie = cookieFrom(await exchange(absoluteFixture, absoluteFixture.nonces.issue()));
    for (let elapsed = sessionPolicy.idleTtlMs / 2; elapsed < sessionPolicy.absoluteTtlMs; elapsed += sessionPolicy.idleTtlMs / 2) {
      absoluteFixture.clock.advance(sessionPolicy.idleTtlMs / 2);
      const response = await localRequest(absoluteFixture, "/api/v1/health", {
        headers: { Cookie: absoluteCookie },
      });
      if (elapsed < sessionPolicy.absoluteTtlMs) expect(response.status).toBe(200);
    }
    absoluteFixture.clock.advance(sessionPolicy.idleTtlMs / 2);
    expect((await localRequest(absoluteFixture, "/api/v1/health", {
      headers: { Cookie: absoluteCookie },
    })).status).toBe(401);
  });

  it("binds capabilities to one session fingerprint and prunes expiry before lifecycle checks", () => {
    const fixture = appFixture();
    let seed = 0;
    const sessions = new InMemorySessionStore(fixture.clock, (size) => Buffer.alloc(size, ++seed));
    const first = sessions.mint(sessionPolicy).token;
    const second = sessions.mint(sessionPolicy).token;
    expect(sessions.fingerprint(first)).toMatch(/^browser:[0-9a-f]{64}$/u);
    expect(sessions.fingerprint(second)).not.toBe(sessions.fingerprint(first));
    expect(sessions.hasActiveSessions()).toBe(true);

    fixture.clock.advance(sessionPolicy.absoluteTtlMs);
    expect(sessions.fingerprint(first)).toBeUndefined();
    expect(sessions.hasActiveSessions()).toBe(false);
    expect(sessions.storedHashes()).toEqual([]);
  });

  it("invalidates an old cookie when the daemon session store restarts", async () => {
    const first = appFixture();
    const cookie = cookieFrom(await exchange(first, first.nonces.issue()));
    const restarted = appFixture();
    const response = await localRequest(restarted, "/api/v1/health", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(401);
  });

  it("logs only method and pathname before authentication", async () => {
    const logs: string[] = [];
    const fixture = appFixture({ logs });
    await localRequest(
      fixture,
      "/api/v1/health?api_key=top-secret&workspace=%2FUsers%2Fprivate%2Fproject&t=legacy-secret",
    );
    expect(logs).toEqual(["GET /api/v1/health"]);
  });
});

describe("loopback listener", () => {
  const listeners: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  });

  it("binds 127.0.0.1 on an OS-selected port and configures Host against that port", async () => {
    const clock = mutableClock();
    const nonces = new InMemoryNonceStore(clock);
    const sessions = new InMemorySessionStore(clock);
    const listener = await bindLoopback((port) => createServerApp({
      port,
      uiOrigins: [],
      nonces,
      sessions,
    }));
    listeners.push(listener);
    expect(listener.hostname).toBe("127.0.0.1");
    expect(listener.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${listener.port}/api/v1/health`);
    expect(response.status).toBe(401);
  });

  it("reports an explicit loopback bind conflict", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    try {
      await expect(bindLoopback(new (await import("hono")).Hono(), address.port))
        .rejects.toBeInstanceOf(LoopbackBindError);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("closes the socket when the listener app factory throws", async () => {
    await expect(bindLoopback(() => { throw new Error("factory failed"); }))
      .rejects.toMatchObject({
        name: "LoopbackBindError",
        cause: expect.objectContaining({ message: "factory failed" }),
      });
  });
});

describe("bridge credential file", () => {
  it("is app-data-only, stores no log copy, and has no group/other read bit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-credential-"));
    const appData = path.join(root, "app-data");
    const workspace = path.join(root, "workspace");
    const token = "bridge-secret-token";
    try {
      const store = new BridgeCredentialStore(appData);
      await store.write(token);
      const metadata = await stat(store.pathname);
      expect(store.pathname.startsWith(appData + path.sep)).toBe(true);
      expect(store.pathname.startsWith(workspace + path.sep)).toBe(false);
      if (hasPosixFileModes) {
        expect(metadata.mode & 0o777).toBe(0o600);
        expect(metadata.mode & 0o077).toBe(0);
      } else {
        // Windows derives `mode` from the read-only flag, so the equivalent
        // owner-only guarantee lives in the ACL. Assert the real one: exactly
        // the current user's SID may reach the credential, and inheritance is
        // gone so no parent grant leaks in.
        // Read the ACL back with icacls, the same tool that wrote it. Get-Acl
        // would give SIDs directly but cannot be relied on: its module fails to
        // load on a locked-down host such as a GitHub runner.
        //
        // What this guards is the defect that shipped: icacls resolves a bare
        // principal as an account name and rejects a raw SID with error 1332, so
        // the grant silently never applied. Seeing the current user in the ACL
        // proves the argument was accepted and the entry exists.
        //
        // It deliberately does not enumerate the other entries. LocalSystem and
        // Administrators appear on some hosts and no ACL can exclude them, since
        // they can take ownership regardless — the standing root has on POSIX,
        // where 0600 does not exclude it either. Asserting the absence of
        // ordinary principals would mean matching names like "Everyone", which
        // are localised; the POSIX leg expresses that property exactly through
        // the mode bits above.
        const acl = execFileSync("icacls", [store.pathname], { encoding: "utf8" });
        const owner = execFileSync("whoami", { encoding: "utf8" }).trim();
        expect(acl.toLowerCase()).toContain(owner.toLowerCase());
      }
      expect(await store.read()).toBe(token);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes inherited Windows ACLs and grants only the current SID", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const run = async (executable: string, args: readonly string[]) => {
      calls.push({ executable, args });
      return { stdout: executable.includes("whoami") ? '"DESKTOP\\user","S-1-5-21-42"\r\n' : "" };
    };
    await secureCredentialFile("C:\\VidCom Data\\credentials", "win32", run);
    expect(calls).toEqual([
      { executable: systemTool("whoami", "win32"), args: ["/user", "/fo", "csv", "/nh"] },
      {
        executable: systemTool("icacls", "win32"),
        args: ["C:\\VidCom Data\\credentials", "/reset"],
      },
      {
        // Absolute, so PATH cannot decide which program sets an ACL — and so a
        // process handed a trimmed PATH can still find it. The packaged smoke
        // gives the artifact an empty PATH on purpose, and extraction died
        // there with `spawnSync icacls ENOENT`.
        executable: systemTool("icacls", "win32"),
        // The `*` prefix is required: icacls resolves a bare principal as an
        // account name and fails with error 1332 on a raw SID.
        args: ["C:\\VidCom Data\\credentials", "/inheritance:r", "/grant:r", "*S-1-5-21-42:(R,W)"],
      },
    ]);

    const directoryCalls: Array<{ executable: string; args: readonly string[] }> = [];
    secureAppDataDirectorySync("C:\\VidCom Data", "win32", (executable, args) => {
      directoryCalls.push({ executable, args });
      return { stdout: executable.includes("whoami") ? '"DESKTOP\\user","S-1-5-21-42"\r\n' : "" };
    });
    expect(directoryCalls).toEqual([
      { executable: systemTool("whoami", "win32"), args: ["/user", "/fo", "csv", "/nh"] },
      {
        executable: systemTool("icacls", "win32"),
        args: ["C:\\VidCom Data", "/reset"],
      },
      {
        executable: systemTool("icacls", "win32"),
        args: ["C:\\VidCom Data", "/inheritance:r", "/grant:r", "*S-1-5-21-42:(OI)(CI)(F)"],
      },
    ]);
  });
});
