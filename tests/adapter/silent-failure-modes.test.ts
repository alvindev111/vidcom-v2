import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { allowlistedEnvironment, verifyBrowserExecutable } from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const POSIX = process.platform !== "win32";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-silent-")));
  roots.push(root);
  return root;
}

/** Writes an executable shell script, which is enough to stand in for a binary. */
async function script(root: string, name: string, body: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
  return file;
}

describe.skipIf(!POSIX)("silent failure mode: a truncated browser download", () => {
  it("accepts a browser that answers --version", async () => {
    const root = await scratch();
    const browser = await script(root, "chrome", "#!/bin/sh\necho 'Chromium 128.0.0.0'\n");

    const verdict = await verifyBrowserExecutable(browser);
    expect(verdict.usable).toBe(true);
    if (!verdict.usable) return;
    expect(verdict.version).toBe("Chromium 128.0.0.0");
  });

  it("rejects a truncated binary that exists but cannot run", async () => {
    const root = await scratch();
    // A partial download: the file is there, the path is real, and nothing
    // about looking at it says the download failed.
    const browser = path.join(root, "chrome");
    await writeFile(browser, "\x7fELF truncated", "utf8");
    await chmod(browser, 0o755);

    const verdict = await verifyBrowserExecutable(browser);
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.reason).toContain("could not be started");
  });

  it("rejects a binary that starts but prints nothing", async () => {
    const root = await scratch();
    const browser = await script(root, "chrome", "#!/bin/sh\nexit 0\n");

    const verdict = await verifyBrowserExecutable(browser);
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.reason).toContain("no version");
  });

  it("does not trust a tool that reports success for a broken download", async () => {
    const root = await scratch();
    // This is the measured behaviour of `hyperframes browser path`: exit 0 and a
    // path, for a 1 MB Chromium that cannot launch.
    const reporter = await script(root, "reporter", `#!/bin/sh\necho '${path.join(root, "chrome")}'\nexit 0\n`);
    const browser = path.join(root, "chrome");
    await writeFile(browser, "truncated", "utf8");
    await chmod(browser, 0o755);

    const reported = await execFileAsync(reporter, [], { encoding: "utf8" });
    expect(reported.stdout.trim()).toBe(browser);

    // The tool says fine; executing the binary says otherwise, and that is the
    // answer the check has to take.
    expect((await verifyBrowserExecutable(browser)).usable).toBe(false);
  });

  it("rejects a relative path without spawning anything", async () => {
    const verdict = await verifyBrowserExecutable("chrome");
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.reason).toContain("not absolute");
  });

  it("gives up on a browser that hangs instead of waiting forever", async () => {
    const root = await scratch();
    const browser = await script(root, "chrome", "#!/bin/sh\nsleep 30\n");

    const started = Date.now();
    const verdict = await verifyBrowserExecutable(browser, 200);
    expect(verdict.usable).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe.skipIf(!POSIX)("silent failure mode: sidecar text encoding", () => {
  it("prints Vietnamese through a child that inherits the forced environment", async () => {
    const root = await scratch();
    const printer = await script(root, "print.sh", "#!/bin/sh\nprintf 'Xin chào thế giới\\n'\n");

    const result = await execFileAsync(printer, [], {
      encoding: "utf8",
      env: allowlistedEnvironment(process.env),
    });
    expect(result.stdout.trim()).toBe("Xin chào thế giới");
  });

  it("carries the forced encoding into the child's own environment", async () => {
    const root = await scratch();
    const printer = await script(root, "env.sh", "#!/bin/sh\necho \"$PYTHONUTF8:$PYTHONIOENCODING\"\n");

    const result = await execFileAsync(printer, [], {
      encoding: "utf8",
      // The parent carries the broken values a Windows console would supply.
      env: allowlistedEnvironment({
        ...process.env,
        PYTHONUTF8: "0",
        PYTHONIOENCODING: "cp932",
      }),
    });
    expect(result.stdout.trim()).toBe("1:utf-8");
  });

  it("still lets a caller force the broken value, which is how the failure is reproduced", async () => {
    const root = await scratch();
    const printer = await script(root, "env.sh", "#!/bin/sh\necho \"[$PYTHONUTF8]\"\n");

    const result = await execFileAsync(printer, [], {
      encoding: "utf8",
      env: allowlistedEnvironment(process.env, { PYTHONUTF8: "" }),
    });
    expect(result.stdout.trim()).toBe("[]");
  });
});
