import { browserAvailability, browserIsRequired, requireBrowser } from "../support/browser-harness";
import { describe, expect, it } from "vitest";

/**
 * The harness that verifies the rest of Phase G.
 *
 * Cookie `SameSite` and SSE behaviour are enforced by a real browser and by
 * nothing else — spike S9 measured `curl` answering differently — so these
 * cases cannot be moved to node. What can be checked everywhere is that the
 * harness itself is honest about whether it ran.
 */
describe("browser session harness", () => {
  it("reports a runnable browser or says why not", async () => {
    const availability = await browserAvailability();

    if (availability.available) {
      expect(availability.chromePath).toBeDefined();
      // Executed, not merely found: a truncated download leaves a file that
      // cannot launch, and S9 showed the download tool reporting success for it.
      expect(availability.version?.length).toBeGreaterThan(0);
      return;
    }
    expect(availability.reason).toContain("chrome-headless-shell");
  });

  it("treats a missing browser as fatal in CI and skippable elsewhere", () => {
    // The rule differs by environment on purpose: nobody should download 200 MB
    // to run the unit suite, and nothing should report green for tests that
    // never ran.
    expect(browserIsRequired()).toBe(process.env.CI === "true" || process.env.CI === "1");
  });

  it("never skips silently", async () => {
    if (browserIsRequired()) {
      // In CI a missing browser must raise rather than return a skip.
      await expect(requireBrowser()).resolves.toMatchObject({ run: true });
      return;
    }
    const outcome = await requireBrowser();
    if (outcome.run) {
      expect(outcome.chromePath.length).toBeGreaterThan(0);
      return;
    }
    // A skip always carries its reason to stdout.
    expect(outcome.message).toContain("skipped");
    process.stdout.write(`${outcome.message}\n`);
  });
});
