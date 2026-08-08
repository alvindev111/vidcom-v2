import { chmodSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const CREDENTIAL_FILENAME = "credentials";
const execFileAsync = promisify(execFile);

export type CredentialCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

export type SyncCredentialCommandRunner = (
  executable: string,
  args: readonly string[],
) => { stdout: string };

function windowsCurrentUserSid(stdout: string): string {
  const sid = stdout.match(/"(S-\d(?:-\d+)+)"/)?.[1];
  if (!sid) throw new Error("could not determine current Windows user SID");
  // icacls resolves a bare principal as an account name; the `*` prefix is what
  // makes it read the value as a SID.
  return `*${sid}`;
}

function windowsCredentialAcl(stdout: string): string {
  return `${windowsCurrentUserSid(stdout)}:(R,W)`;
}

let cachedWhoamiOutput: string | undefined;

/**
 * Default runners answer `whoami` from a per-process cache.
 *
 * The current user's SID cannot change while the process lives, yet every
 * protected file and directory used to pay a fresh subprocess for it — the
 * dominant cost of securing a tree on Windows. Injected runners are left
 * untouched so callers that assert the exact command sequence still see it.
 */
function isWhoami(executable: string): boolean {
  return executable === "whoami";
}

const defaultSyncRunner: SyncCredentialCommandRunner = (executable, args) => {
  if (isWhoami(executable) && cachedWhoamiOutput !== undefined) {
    return { stdout: cachedWhoamiOutput };
  }
  const stdout = execFileSync(executable, [...args], { encoding: "utf8" });
  if (isWhoami(executable)) cachedWhoamiOutput = stdout;
  return { stdout };
};

const defaultAsyncRunner: CredentialCommandRunner = async (executable, args) => {
  if (isWhoami(executable) && cachedWhoamiOutput !== undefined) {
    return { stdout: cachedWhoamiOutput };
  }
  const { stdout } = await execFileAsync(executable, [...args]);
  if (isWhoami(executable)) cachedWhoamiOutput = stdout;
  return { stdout };
};

/** Applies POSIX 0600 or a Windows ACL containing only the current user. */
export async function secureCredentialFile(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
  run: CredentialCommandRunner = defaultAsyncRunner,
): Promise<void> {
  if (platform !== "win32") {
    await chmod(pathname, 0o600);
    return;
  }

  const { stdout } = await run("whoami", ["/user", "/fo", "csv", "/nh"]);
  await run("icacls", [pathname, "/inheritance:r", "/grant:r", windowsCredentialAcl(stdout)]);
}

/** Synchronous variant for resources, such as SQLite, opened by synchronous Node APIs. */
export function secureCredentialFileSync(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
  run: SyncCredentialCommandRunner = defaultSyncRunner,
): void {
  if (platform !== "win32") {
    chmodSync(pathname, 0o600);
    return;
  }
  const { stdout } = run("whoami", ["/user", "/fo", "csv", "/nh"]);
  run("icacls", [pathname, "/inheritance:r", "/grant:r", windowsCredentialAcl(stdout)]);
}

/** Restricts an app-data directory before any credential, database or audit bytes are created. */
export function secureAppDataDirectorySync(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
  run: SyncCredentialCommandRunner = defaultSyncRunner,
): void {
  if (platform !== "win32") {
    chmodSync(pathname, 0o700);
    return;
  }
  const { stdout } = run("whoami", ["/user", "/fo", "csv", "/nh"]);
  run("icacls", [
    pathname,
    "/inheritance:r",
    "/grant:r",
    `${windowsCurrentUserSid(stdout)}:(OI)(CI)(F)`,
  ]);
}

/** Stores the future MCP bridge credential under app-data, never in a workspace. */
export class BridgeCredentialStore {
  readonly pathname: string;

  constructor(appDataRoot: string) {
    this.pathname = path.join(appDataRoot, CREDENTIAL_FILENAME);
  }

  async write(token: string): Promise<void> {
    const directory = path.dirname(this.pathname);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${CREDENTIAL_FILENAME}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        // On Windows the inherited ACL exists at creation time. Restrict the
        // still-empty temp before any credential bytes become observable.
        await secureCredentialFile(temporary);
        await handle.writeFile(token, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.pathname);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  read(): Promise<string> {
    return readFile(this.pathname, "utf8");
  }
}
