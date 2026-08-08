import { assertDevHosts, checkDevHosts } from "../../src/lib/api/dev-host-check";
import { describe, expect, it } from "vitest";

describe("dev host mismatch", () => {
  it("accepts the same hostname on a different port", () => {
    // A port is not part of a site, so SameSite=Strict survives this.
    expect(checkDevHosts({
      pageOrigin: "http://localhost:3000",
      apiBaseUrl: "http://localhost:7788",
    })).toEqual({ ok: true });
  });

  it("refuses localhost against 127.0.0.1, which loses the cookie silently", () => {
    // Measured in S9: exchange returns 200 and the cookie never comes back.
    const verdict = checkDevHosts({
      pageOrigin: "http://localhost:3000",
      apiBaseUrl: "http://127.0.0.1:7788",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("127.0.0.1");
    // The message has to name the silent part, or whoever reads it goes
    // hunting through session code.
    expect(verdict.reason).toContain("returns 200");
  });

  it("accepts a same-origin deployment with no API base at all", () => {
    expect(checkDevHosts({ pageOrigin: "http://127.0.0.1:7788", apiBaseUrl: "" }))
      .toEqual({ ok: true });
  });

  it("refuses a base it cannot read a hostname from", () => {
    expect(checkDevHosts({ pageOrigin: "http://localhost:3000", apiBaseUrl: "not a url" }).ok)
      .toBe(false);
  });

  it("fails at boot rather than at the first request", () => {
    // A failure at request time reads as an authentication bug; a failure here
    // names the cause once, before anything else looks broken.
    expect(() => assertDevHosts({
      pageOrigin: "http://localhost:3000",
      apiBaseUrl: "http://127.0.0.1:7788",
    })).toThrow(/dev host mismatch/u);

    expect(() => assertDevHosts({
      pageOrigin: "http://localhost:3000",
      apiBaseUrl: "http://localhost:7788",
    })).not.toThrow();
  });
});
