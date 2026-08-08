import { homedir } from "node:os";
import path from "node:path";

import { resolveChrome } from "@vidcom/adapter";

export interface BrowserAvailability {
  available: boolean;
  chromePath?: string;
  version?: string;
  reason?: string;
}

/**
 * Default place a HyperFrames download puts `chrome-headless-shell`.
 *
 * Used only when no runtime supplied a `browserCacheRoot`; a packaged artifact
 * always names one.
 */
function defaultCacheRoot(): string {
  return path.join(homedir(), ".cache", "hyperframes", "chrome");
}

/**
 * Reports whether a real browser can be driven here.
 *
 * Two rules, and they differ on purpose. On a developer machine a missing
 * Chrome **skips with the reason printed**, because nobody should have to
 * download 200 MB to run the unit suite. In CI a missing Chrome **fails**: the
 * only thing worse than not running these tests is believing they ran. Cookie
 * `SameSite` behaviour is enforced by the browser and nothing else — S9 showed
 * `curl` answering differently — so a silent skip here is a silent hole.
 */
export async function browserAvailability(browserCacheRoot?: string): Promise<BrowserAvailability> {
  const resolved = await resolveChrome({
    browserCacheRoot: browserCacheRoot ?? defaultCacheRoot(),
    ...process.env.CHROME_PATH ? { chromePathOverride: process.env.CHROME_PATH } : {},
  });
  if (resolved) return { available: true, chromePath: resolved.path, version: resolved.version };
  return {
    available: false,
    reason: "no runnable chrome-headless-shell was found; set CHROME_PATH or install the browser cache",
  };
}

/** True when a missing browser must fail rather than skip. */
export function browserIsRequired(): boolean {
  return process.env.CI === "true" || process.env.CI === "1";
}

/**
 * Resolves how a suite should react to the browser being absent.
 *
 * Returns the message to print when skipping, so a skipped run always says why
 * rather than passing quietly.
 */
export async function requireBrowser(browserCacheRoot?: string): Promise<
  { run: true; chromePath: string } | { run: false; message: string }
> {
  const availability = await browserAvailability(browserCacheRoot);
  if (availability.available && availability.chromePath) {
    return { run: true, chromePath: availability.chromePath };
  }
  const message = `browser session tests skipped: ${availability.reason ?? "unknown"}`;
  if (browserIsRequired()) {
    throw new Error(`browser session tests cannot be skipped in CI — ${availability.reason ?? "unknown"}`);
  }
  return { run: false, message };
}
