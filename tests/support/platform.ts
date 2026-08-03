import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Whether this process may create symlinks.
 *
 * POSIX always allows it. Windows requires either Developer Mode or an elevated
 * process, so the answer is a property of the machine and account rather than of
 * the platform — probed once instead of assumed from `process.platform`, so a
 * Windows box with Developer Mode on still runs the containment suites.
 */
export const canCreateSymlinks: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "vidcom-symlink-probe-"));
  try {
    symlinkSync(path.join(probe, "target"), path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * Whether the filesystem reports POSIX permission bits.
 *
 * Windows derives `mode` from a read-only flag rather than from an ACL, so a
 * file secured to one SID still reports 0o666. Ownership there is asserted
 * through the ACL instead — see the credential-store suites.
 */
export const hasPosixFileModes: boolean = process.platform !== "win32";

/**
 * Whether a child process can observe and ignore a graceful stop signal.
 *
 * Windows has no signal delivery: `child.kill("SIGTERM")` maps to
 * TerminateProcess, so a child cannot trap it and an escalation-to-SIGKILL path
 * can never be exercised there.
 */
export const hasPosixSignals: boolean = process.platform !== "win32";

/**
 * Budget for end-to-end cases that pack the CLI and drive real child processes.
 *
 * Windows pays for process creation, the .cmd shim hop and antivirus inspection
 * on every spawn, and these run alongside the rest of the suite, so the same
 * work needs several times the POSIX budget.
 */
export const heavyE2eTimeout: number = process.platform === "win32" ? 180_000 : 30_000;

/**
 * Removes a temp tree, tolerating the short window after a child exits during
 * which Windows still holds its working directory open.
 *
 * A directory that is any live process's current directory cannot be removed on
 * Windows, and the handle outlives the exit notification, so a first attempt can
 * lose a race that no amount of awaiting the child prevents.
 */
export async function removeTree(root: string, budgetMs = 10_000): Promise<void> {
  const { rm } = await import("node:fs/promises");
  const deadline = Date.now() + budgetMs;
  for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM";
      if (!retryable || Date.now() + delay >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
