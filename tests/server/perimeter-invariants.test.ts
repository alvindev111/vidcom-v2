import { Hono } from "hono";

import { hostCheck } from "@vidcom/server";
import { describe, expect, it } from "vitest";

const PORT = 41_234;

/**
 * Drives the middleware directly and reports whether it let the request through.
 *
 * The middleware signals refusal by throwing a domain error that the error
 * mapper turns into 403 further out; asserting the invariant here keeps the
 * test about the perimeter rule rather than about the mapper.
 */
async function allows(host: string | undefined): Promise<boolean> {
  const app = new Hono();
  app.use("*", hostCheck(PORT));
  app.get("/v1/health", (c) => c.json({ ok: true }));
  // Handled inside the app rather than caught outside it. Letting the throw
  // escape `app.request` leaves an unhandled rejection that passes locally and
  // fails CI, which is a worse bug than the one being tested for.
  app.onError(() => new Response(null, { status: 403 }));
  // Any refusal counts: the middleware signals it by throwing, and the error
  // mapper turns that into 403 further out. Asserting here keeps the test about
  // the perimeter rule rather than about the mapper.
  const response = await app.request(
    "http://127.0.0.1/v1/health",
    host === undefined ? {} : { headers: { Host: host } },
  );
  return response.status === 200;
}

/**
 * The perimeter is a Phase 1 guarantee that Phase 4 must not widen.
 *
 * Everything Phase 4 adds — the bridge, the daemon, workspace switching —
 * arrives behind this check, so a rule relaxed here silently reopens the daemon
 * to anything that can reach the port.
 */
describe("loopback perimeter invariants", () => {
  it("accepts only the two loopback spellings on the exact port", async () => {
    expect(await allows(`127.0.0.1:${PORT}`)).toBe(true);
    expect(await allows(`localhost:${PORT}`)).toBe(true);
  });

  it.each([
    ["a different port", `127.0.0.1:${PORT + 1}`],
    ["no port at all", "127.0.0.1"],
    ["an external host", "example.com"],
    ["an external host on the right port", `example.com:${PORT}`],
    ["a rebinding host that resolves to loopback", `127.0.0.1.nip.io:${PORT}`],
    ["the IPv6 loopback, which is not in the allowlist", `[::1]:${PORT}`],
    ["a host that merely contains an allowed one", `evil-127.0.0.1:${PORT}`],
    ["an empty header", ""],
  ])("refuses %s", async (_label, host) => {
    expect(await allows(host)).toBe(false);
  });
});
