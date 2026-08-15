import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CompilerGuard,
  ESBUILD_BINARY_PATH,
  ESBUILD_WORKER_THREADS,
  NodeProcessRunner,
  NodeRenderBinaryProbe,
  allowlistedEnvironment,
  verifyBrowserExecutable,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";
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

  it.each([
    "Google Chrome 128.0.6613.86",
    "Google Chrome for Testing 128.0.6613.86",
    "Chrome Headless Shell 128.0.6613.86",
    "Headless Shell 128.0.6613.86",
  ])("accepts the supported browser version shape %s", async (version) => {
    const root = await scratch();
    const browser = await script(root, "chrome", `#!/bin/sh\necho '${version}'\n`);

    await expect(verifyBrowserExecutable(browser)).resolves.toMatchObject({
      usable: true,
      version,
    });
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
    expect(verdict.reason).toContain("did not report a Chromium/Chrome version");
  });

  it("rejects a runnable executable that prints an arbitrary version", async () => {
    const root = await scratch();
    const executable = await script(root, "bun", "#!/bin/sh\necho '1.3.5'\n");

    const verdict = await verifyBrowserExecutable(executable);
    expect(verdict.usable).toBe(false);
    if (verdict.usable) return;
    expect(verdict.reason).toContain("did not report a Chromium/Chrome version");
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

describe("D.11 integration: three silent production failures", () => {
  it("returns bounded or coded failures instead of hanging, trusting a reporter, or emitting mangled text", async () => {
    const root = await scratch();

    // 1. Missing either esbuild variable must fail before an operation with the
    // exact real failure shape (no error, no stderr, never settles) is entered.
    const esbuildPath = path.join(root, process.platform === "win32" ? "esbuild.exe" : "esbuild");
    for (const missing of [ESBUILD_BINARY_PATH, ESBUILD_WORKER_THREADS] as const) {
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        [ESBUILD_BINARY_PATH]: esbuildPath,
        [ESBUILD_WORKER_THREADS]: "0",
      };
      delete environment[missing];
      const startedAt = Date.now();
      const result = await new CompilerGuard({ esbuildBinaryPath: esbuildPath, environment }).run(
        () => new Promise<never>(() => {}),
        30_000,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: ErrorCode.CompilerUnavailable, details: { unmet: [missing] } },
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }

    // 2. Reproduce the measured Chromium trap through NodeRenderBinaryProbe:
    // the HyperFrames reporter exits 0 and prints a real executable path, but
    // the file is truncated and therefore cannot answer --version.
    const browser = path.join(root, process.platform === "win32" ? "chrome-truncated.exe" : "chrome-truncated");
    const hyperframesCliPath = path.join(root, "hyperframes.mjs");
    const hyperframesPackagePath = path.join(root, "package.json");
    await Promise.all([
      writeFile(browser, "truncated browser payload", "utf8"),
      writeFile(hyperframesPackagePath, JSON.stringify({ version: "0.7.86" }), "utf8"),
      writeFile(
        hyperframesCliPath,
        `if (process.argv.slice(-2).join(" ") === "browser path") process.stdout.write(${JSON.stringify(`${browser}\n`)});\n`,
        "utf8",
      ),
    ]);
    if (POSIX) await chmod(browser, 0o755);
    const binaryResult = await new NodeRenderBinaryProbe({
      hyperframesCliPath: hyperframesCliPath as AbsolutePath,
      hyperframesPackagePath: hyperframesPackagePath as AbsolutePath,
      browserCacheRoot: path.join(root, "browser-cache") as AbsolutePath,
      ffmpegPath: process.execPath as AbsolutePath,
      ffprobePath: process.execPath as AbsolutePath,
    }, { appDataRoot: root }).probe(root as AbsolutePath);
    expect(binaryResult).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.RenderBinaryMissing,
        details: { missing: ["chromium"] },
      },
    });

    // 3. A deterministic frozen-sidecar harness models a non-UTF-8 Windows
    // locale. The real process runner overwrites hostile ambient values and the
    // child round-trips Vietnamese. Removing PYTHONUTF8 explicitly reproduces
    // the failure as a coded empty-output response, never garbled stdout.
    const observationPath = path.join(root, "sidecar-environment.json");
    const sidecarPath = path.join(root, "encoding-sidecar.cjs");
    await mkdir(path.dirname(observationPath), { recursive: true });
    await writeFile(sidecarPath, `
      const fs = require("node:fs");
      const observed = {
        PYTHONUTF8: process.env.PYTHONUTF8 ?? null,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? null,
      };
      fs.writeFileSync(process.argv[2], JSON.stringify(observed));
      if (observed.PYTHONUTF8 !== "1" || observed.PYTHONIOENCODING !== "utf-8") {
        process.stderr.write(JSON.stringify({ code: ${JSON.stringify(ErrorCode.TtsProviderUnavailable)} }));
        process.exit(86);
      }
      process.stdout.write("Xin chào thế giới");
    `, "utf8");
    const previous = {
      PYTHONUTF8: process.env.PYTHONUTF8,
      PYTHONIOENCODING: process.env.PYTHONIOENCODING,
    };
    process.env.PYTHONUTF8 = "0";
    process.env.PYTHONIOENCODING = "cp932";
    try {
      const processes = new NodeProcessRunner(5_000);
      const healthy = await processes.run({
        command: [process.execPath, sidecarPath, observationPath],
      });
      expect(healthy).toMatchObject({ exitCode: 0, stdout: "Xin chào thế giới", timedOut: false });
      expect(JSON.parse(await readFile(observationPath, "utf8"))).toEqual({
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      });

      const missingUtf8 = await processes.run({
        command: [process.execPath, sidecarPath, observationPath],
        environment: { PYTHONUTF8: "" },
      });
      expect(missingUtf8.exitCode).toBe(86);
      expect(missingUtf8.stdout).toBe("");
      expect(JSON.parse(missingUtf8.stderr)).toEqual({ code: ErrorCode.TtsProviderUnavailable });
    } finally {
      if (previous.PYTHONUTF8 === undefined) delete process.env.PYTHONUTF8;
      else process.env.PYTHONUTF8 = previous.PYTHONUTF8;
      if (previous.PYTHONIOENCODING === undefined) delete process.env.PYTHONIOENCODING;
      else process.env.PYTHONIOENCODING = previous.PYTHONIOENCODING;
    }
  });
});
