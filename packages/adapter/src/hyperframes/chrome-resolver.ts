import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  verifyBrowserExecutable,
  verifyManagedBrowserExecutable,
  type BrowserVerdict,
} from "./browser-verification";

export interface ChromeResolution {
  path: string;
  version: string;
}

export interface ChromeResolveInput {
  /** From `RuntimePaths.browserCacheRoot`; where a download lands. */
  browserCacheRoot?: string;
  /** Developer override, taken ahead of the cache. */
  chromePathOverride?: string;
}

const SHELL_NAME = process.platform === "win32"
  ? "chrome-headless-shell.exe"
  : "chrome-headless-shell";
// Production points HyperFrames at a synthetic HOME rooted at the coordinated
// component. Its managed cache is `<root>/.cache/hyperframes/chrome/<version>/<platform>`.
const MAX_CACHE_DEPTH = 6;

async function candidatesUnder(cacheRoot: string): Promise<string[]> {
  // The download layout nests a version directory and then a platform
  // directory, and both names change with every release — so the tree is
  // walked rather than guessed at.
  const found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_CACHE_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.name === SHELL_NAME) found.push(target);
    }
  };
  await visit(cacheRoot, 0);
  return found.sort();
}

/**
 * Finds a Chrome that actually runs.
 *
 * A path is not proof. Measured in spike S9: after a truncated download the
 * file is present, the tool that manages the download reports success, and the
 * binary still cannot launch — so every candidate is executed with `--version`
 * before it is accepted.
 *
 * This is the one resolver. The doctor check for `chrome.cache` uses it too:
 * two ways to find Chrome would be two places to be wrong about it, and they
 * would disagree exactly when it matters.
 */
export async function resolveChrome(input: ChromeResolveInput): Promise<ChromeResolution | null> {
  if (input.chromePathOverride) {
    const verdict: BrowserVerdict = await verifyBrowserExecutable(input.chromePathOverride);
    if (verdict.usable) return { path: input.chromePathOverride, version: verdict.version };
  }
  if (input.browserCacheRoot) {
    for (const candidate of await candidatesUnder(input.browserCacheRoot)) {
      const verdict = await verifyManagedBrowserExecutable(candidate, input.browserCacheRoot);
      if (verdict.usable) {
        return { path: verdict.canonicalPath, version: verdict.version };
      }
    }
  }
  return null;
}
