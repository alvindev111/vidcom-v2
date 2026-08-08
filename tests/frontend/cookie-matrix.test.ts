import { checkDevHosts } from "../../src/lib/api/dev-host-check";
import { requireBrowser } from "../support/browser-harness";
import { describe, expect, it } from "vitest";

/**
 * The cookie matrix measured in spike S9, kept as the expectation.
 *
 * `SameSite` is enforced by the browser and by nothing else — S9 recorded
 * `curl` answering differently for the same request — so the second row cannot
 * be checked any other way. Both rows are stated here so the pair is read
 * together: a port change is fine, a hostname change is not, and the failure is
 * silent.
 */
const S9_MATRIX = [
  {
    label: "same hostname, different port keeps SameSite=Strict",
    pageOrigin: "http://localhost:3000",
    apiBaseUrl: "http://localhost:7788",
    cookieSurvives: true,
  },
  {
    label: "localhost page against a 127.0.0.1 API loses the cookie",
    pageOrigin: "http://localhost:3000",
    apiBaseUrl: "http://127.0.0.1:7788",
    cookieSurvives: false,
  },
] as const;

describe("S9 cookie matrix", () => {
  it.each(S9_MATRIX)("$label", ({ pageOrigin, apiBaseUrl, cookieSurvives }) => {
    // The boot check has to agree with the measurement exactly. If it ever
    // accepted the second row, the app would ship a setup where `exchange`
    // returns 200 and the session silently never arrives.
    expect(checkDevHosts({ pageOrigin, apiBaseUrl }).ok).toBe(cookieSurvives);
  });

  it("fails at boot for the losing row rather than at the first request", () => {
    const losing = S9_MATRIX[1];
    const verdict = checkDevHosts({
      pageOrigin: losing.pageOrigin,
      apiBaseUrl: losing.apiBaseUrl,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // G.3's requirement: the message names the silent part, because a caller
    // who only sees "unauthorised" goes looking in session code.
    expect(verdict.reason).toContain("returns 200");
  });
});

describe("browser-driven session", () => {
  it("has a browser to drive, or says why it is skipping", async () => {
    const outcome = await requireBrowser();

    if (!outcome.run) {
      // Skipping is allowed here and fails in the browser-session workflow,
      // where VIDCOM_REQUIRE_BROWSER is set because the browser was installed.
      process.stdout.write(`${outcome.message}\n`);
      expect(outcome.message).toContain("skipped");
      return;
    }
    expect(outcome.chromePath.length).toBeGreaterThan(0);
  });
});
