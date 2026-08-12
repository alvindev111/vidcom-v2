import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  secureAppDataDirectorySync,
  secureCredentialFile,
  secureCredentialFileSync,
  systemTool,
} from "@vidcom/adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const SID_OUTPUT = '"DESKTOP\\user","S-1-5-21-42"\r\n';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-acl-security-"));
  roots.push(root);
  return root;
}

describe("credential and app-data ACL hardening", () => {
  it("resets explicit Windows file ACEs before publishing the exact current-user ACL", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    await secureCredentialFile("C:\\VidCom Data\\credentials", "win32", async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: executable.includes("whoami") ? SID_OUTPUT : "" };
    });

    expect(calls).toEqual([
      { executable: systemTool("whoami", "win32"), args: ["/user", "/fo", "csv", "/nh"] },
      {
        executable: systemTool("icacls", "win32"),
        args: ["C:\\VidCom Data\\credentials", "/reset"],
      },
      {
        executable: systemTool("icacls", "win32"),
        args: ["C:\\VidCom Data\\credentials", "/inheritance:r", "/grant:r", "*S-1-5-21-42:(R,W)"],
      },
    ]);
  });

  it("uses the same reset-first Windows contract for synchronous files and directories", () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const run = (executable: string, args: readonly string[]) => {
      calls.push({ executable, args });
      return { stdout: executable.includes("whoami") ? SID_OUTPUT : "" };
    };
    secureCredentialFileSync("C:\\VidCom Data\\database.sqlite", "win32", run);
    secureAppDataDirectorySync("C:\\VidCom Data", "win32", run);

    expect(calls).toEqual([
      { executable: systemTool("whoami", "win32"), args: ["/user", "/fo", "csv", "/nh"] },
      { executable: systemTool("icacls", "win32"), args: ["C:\\VidCom Data\\database.sqlite", "/reset"] },
      {
        executable: systemTool("icacls", "win32"),
        args: ["C:\\VidCom Data\\database.sqlite", "/inheritance:r", "/grant:r", "*S-1-5-21-42:(R,W)"],
      },
      { executable: systemTool("whoami", "win32"), args: ["/user", "/fo", "csv", "/nh"] },
      { executable: systemTool("icacls", "win32"), args: ["C:\\VidCom Data", "/reset"] },
      {
        executable: systemTool("icacls", "win32"),
        args: ["C:\\VidCom Data", "/inheritance:r", "/grant:r", "*S-1-5-21-42:(OI)(CI)F"],
      },
    ]);
  });

  it("keeps asynchronous POSIX credential hardening at 0600 without invoking Windows tools", async () => {
    const root = await temporaryRoot();
    const credential = path.join(root, "credential");
    await writeFile(credential, "secret", { mode: 0o666 });
    await chmod(credential, 0o666);
    const run = vi.fn();

    await secureCredentialFile(credential, "linux", run);

    expect((await stat(credential)).mode & 0o777).toBe(0o600);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps synchronous POSIX file and directory hardening at 0600 and 0700", async () => {
    const root = await temporaryRoot();
    const credential = path.join(root, "database.sqlite");
    await writeFile(credential, "bytes", { mode: 0o666 });
    await chmod(root, 0o777);
    await chmod(credential, 0o666);
    const run = vi.fn();

    secureCredentialFileSync(credential, "linux", run);
    secureAppDataDirectorySync(root, "linux", run);

    expect((await stat(credential)).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(run).not.toHaveBeenCalled();
  });
});
