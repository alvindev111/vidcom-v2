import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { allowlistedEnvironment } from "../runtime/process-environment";

const execFileAsync = promisify(execFile);

export type BrowserVerdict =
  | { usable: true; version: string }
  | { usable: false; reason: string };

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
    if (version.length === 0) {
      return { usable: false, reason: "the browser reported no version" };
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
