import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { allowlistedEnvironment } from "../runtime/process-environment";

const execFileAsync = promisify(execFile);

export type BrowserVerdict =
  | { usable: true; version: string }
  | { usable: false; reason: string };

export type ManagedBrowserVerdict =
  | { usable: true; version: string; canonicalPath: string }
  | { usable: false; reason: string };

const BROWSER_VERSION = /^(?:Chromium|Google Chrome(?: for Testing)?|Chrome(?: Headless Shell)?|Headless Shell)\s+\d+(?:\.\d+){1,3}(?:\s+.*)?$/iu;

function contained(authority: string, candidate: string): boolean {
  const relative = path.relative(authority, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Proves a browser binary can actually start, by starting it.
 *
 * A path is not evidence. Measured on Windows: after a truncated download,
 * `hyperframes browser path` prints a path and exits 0 for a 1 MB Chromium that
 * cannot launch — so asking the tool that manages the download whether the
 * download worked returns yes either way. Executing `--version` is the cheapest
 * thing that fails when the binary is broken.
 */
export async function verifyBrowserExecutable(
  browserPath: string,
  timeoutMs = 10_000,
): Promise<BrowserVerdict> {
  if (!path.isAbsolute(browserPath)) {
    return { usable: false, reason: "browser path is not absolute" };
  }
  try {
    const result = await execFileAsync(browserPath, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: allowlistedEnvironment(process.env),
    });
    const version = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
    if (!BROWSER_VERSION.test(version)) {
      return { usable: false, reason: "the executable did not report a Chromium/Chrome version" };
    }
    return { usable: true, version };
  } catch (error) {
    const failure = error as { killed?: boolean; code?: unknown; message?: string };
    if (failure.killed === true) {
      return { usable: false, reason: `the browser did not answer within ${timeoutMs}ms` };
    }
    return {
      usable: false,
      reason: `the browser could not be started: ${failure.message ?? String(error)}`,
    };
  }
}

/**
 * Verifies a managed browser without letting a CLI-reported path escape its
 * component authority. Explicit user overrides use `verifyBrowserExecutable`
 * directly and may live elsewhere; managed downloads may not.
 */
export async function verifyManagedBrowserExecutable(
  browserPath: string,
  cacheRoot: string,
  timeoutMs = 10_000,
): Promise<ManagedBrowserVerdict> {
  if (!path.isAbsolute(cacheRoot) || !path.isAbsolute(browserPath)) {
    return { usable: false, reason: "managed browser paths must be absolute" };
  }
  try {
    const [rootMetadata, candidateMetadata] = await Promise.all([
      lstat(cacheRoot),
      lstat(browserPath),
    ]);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return { usable: false, reason: "managed browser cache root is not a real directory" };
    }
    if (!candidateMetadata.isFile() || candidateMetadata.isSymbolicLink()) {
      return { usable: false, reason: "managed browser candidate is not a regular non-symlink file" };
    }
    const [authority, canonicalPath] = await Promise.all([
      realpath(cacheRoot),
      realpath(browserPath),
    ]);
    if (!contained(authority, canonicalPath)) {
      return { usable: false, reason: "managed browser candidate escapes its cache root" };
    }
    const verdict = await verifyBrowserExecutable(canonicalPath, timeoutMs);
    return verdict.usable
      ? { ...verdict, canonicalPath }
      : verdict;
  } catch (error) {
    return {
      usable: false,
      reason: `managed browser candidate could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
