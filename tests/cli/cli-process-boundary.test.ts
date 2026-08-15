import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RENDER_EXIT, runCliMain } from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

const SOURCE_LAUNCHER = path.resolve("packages/cli/bin/vidcom.mjs");
const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-cli-boundary-")));
  roots.push(root);
  return root;
}

function sourceEnvironment(
  root: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    VIDCOM_APP_DATA: path.join(root, "app-data"),
    VIDCOM_SETTINGS: path.join(root, "setting.json"),
    // Source mode must stay source mode even when the parent test process is
    // running an artifact-oriented suite.
    VIDCOM_RUNTIME_ASSETS: "",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI process exit boundary", () => {
  it.each([
    ["failed", RENDER_EXIT.failed],
    ["cancelled", RENDER_EXIT.interrupted],
  ])("returns the render %s exit code from the normal command seam", async (_status, exitCode) => {
    let stderr = "";

    await expect(runCliMain(["render"], {
      stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
    }, () => Promise.resolve(exitCode))).resolves.toBe(exitCode);
    expect(stderr).toBe("");
  });

  it("preserves a broken strict-doctor exit through the real source launcher", async () => {
    const root = await scratch();
    const appDataRoot = path.join(root, "app-data");
    const result = spawnSync(process.execPath, [SOURCE_LAUNCHER, "doctor", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: sourceEnvironment(root, { VIDCOM_DOCTOR_STRICT: "1" }),
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as { items?: Array<{ id?: string; status?: string }> };
    expect(report.items?.some((item) => item.status === "missing" || item.status === "broken"))
      .toBe(true);
    expect(report.items?.find((item) => item.id === "runtime.integrity")?.status).toBe("missing");
    expect((await stat(path.join(appDataRoot, "vidcom.sqlite"))).isFile()).toBe(true);
  }, 60_000);

  it("sanitizes a pre-runtime compiler failure in the real source launcher", async () => {
    const root = await scratch();
    const missingRuntimeAssets = path.join(root, "private-runtime-assets");
    const result = spawnSync(process.execPath, [SOURCE_LAUNCHER, "version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: sourceEnvironment(root, { VIDCOM_RUNTIME_ASSETS: missingRuntimeAssets }),
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("compiler_unavailable\n");
    expect(result.stderr).not.toContain(missingRuntimeAssets);
    expect(result.stderr).not.toContain(process.cwd());
    expect(result.stderr).not.toMatch(/\bat\s+\S+|Error:/u);
  }, 60_000);
});
