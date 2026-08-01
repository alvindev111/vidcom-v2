import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CREDENTIAL_FILENAME = "credentials";
const execFileAsync = promisify(execFile);

export type CredentialCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

/** Applies POSIX 0600 or a Windows ACL containing only the current user. */
export async function secureCredentialFile(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
  run: CredentialCommandRunner = (executable, args) => execFileAsync(executable, [...args]),
): Promise<void> {
  if (platform !== "win32") {
    await chmod(pathname, 0o600);
    return;
  }

  const { stdout } = await run("whoami", ["/user", "/fo", "csv", "/nh"]);
  const sid = stdout.match(/"(S-\d(?:-\d+)+)"/)?.[1];
  if (!sid) throw new Error("could not determine current Windows user SID");
  await run("icacls", [pathname, "/inheritance:r", "/grant:r", `${sid}:(R,W)`]);
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
