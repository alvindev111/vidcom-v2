import { stat } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configureCompilerBeforeRuntime,
  resolveArtifactEsbuildBinary,
  resolveDevelopmentEsbuildBinary,
} from "../../packages/cli/src/compiler-preload";
import { runBootstrappedCli } from "../../packages/cli/src/boot";
import { ESBUILD_BINARY_PATH, ESBUILD_WORKER_THREADS } from "@vidcom/adapter/compiler-guard";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-compiler-preload-"));
  roots.push(root);
  return root;
}

function manifest(target = "node"): unknown {
  return {
    artifactVersion: "2026.08.09",
    archives: [{ key: "node", platform: "win32-x64", target }],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiler preload", () => {
  it("resolves the native binary owned by HyperFrames in a source checkout", async () => {
    const binary = resolveDevelopmentEsbuildBinary();

    expect(path.isAbsolute(binary)).toBe(true);
    expect((await stat(binary)).isFile()).toBe(true);
    expect(binary).not.toMatch(/[\\/]esbuild[\\/]bin[\\/]esbuild$/u);
  });

  it("derives the cold artifact path from archive.target and the platform suffix", async () => {
    const appDataRoot = await scratch();

    expect(resolveArtifactEsbuildBinary({
      appDataRoot,
      manifest: manifest("toolchain/node-runtime"),
      platform: "win32",
      architecture: "x64",
    })).toBe(path.join(
      appDataRoot,
      "native",
      "2026.08.09",
      "toolchain/node-runtime",
      "bin",
      "esbuild.exe",
    ));
  });

  it("reads appDataRoot from a real settings file before configuring artifact env", async () => {
    const home = await scratch();
    const appDataRoot = path.join(home, "chosen-app-data");
    await mkdir(path.join(home, ".vidcom"), { recursive: true });
    await writeFile(path.join(home, ".vidcom", "setting.json"), JSON.stringify({ appDataRoot }), "utf8");
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };

    const binary = await configureCompilerBeforeRuntime({
      environment,
      homeDirectory: home,
      platform: "win32",
      architecture: "x64",
      readSeaManifest: () => manifest(),
    });

    expect(binary).toBe(path.join(appDataRoot, "native", "2026.08.09", "node", "bin", "esbuild.exe"));
    expect(environment.VIDCOM_APP_DATA).toBe(appDataRoot);
    expect(environment[ESBUILD_BINARY_PATH]).toBe(binary);
    expect(environment[ESBUILD_WORKER_THREADS]).toBe("0");
  });

  it("keeps an explicit app-data environment override ahead of settings", async () => {
    const home = await scratch();
    const settingsRoot = path.join(home, "settings-app-data");
    const environmentRoot = path.join(home, "environment-app-data");
    await mkdir(path.join(home, ".vidcom"), { recursive: true });
    await writeFile(
      path.join(home, ".vidcom", "setting.json"),
      JSON.stringify({ appDataRoot: settingsRoot }),
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      VIDCOM_APP_DATA: environmentRoot,
    };

    const binary = await configureCompilerBeforeRuntime({
      environment,
      homeDirectory: home,
      platform: "win32",
      architecture: "x64",
      readSeaManifest: () => manifest(),
    });

    expect(environment.VIDCOM_APP_DATA).toBe(environmentRoot);
    expect(binary).toBe(path.join(
      environmentRoot,
      "native",
      "2026.08.09",
      "node",
      "bin",
      "esbuild.exe",
    ));
  });

  it("sets both variables before dynamically loading the normal runtime", async () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const home = await scratch();
    let loaded = false;

    const exitCode = await runBootstrappedCli(["version"], {
      compiler: { environment, homeDirectory: home },
      loadRuntime: async () => {
        loaded = true;
        expect(environment[ESBUILD_BINARY_PATH]).toBe(resolveDevelopmentEsbuildBinary());
        expect(environment[ESBUILD_WORKER_THREADS]).toBe("0");
        return { runCliMain: async () => 17 };
      },
    });

    expect(loaded).toBe(true);
    expect(exitCode).toBe(17);
  });

  it.each([1, 130])("preserves delegated runtime exit code %i", async (delegatedExitCode) => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const home = await scratch();

    await expect(runBootstrappedCli(["render"], {
      compiler: { environment, homeDirectory: home },
      loadRuntime: () => Promise.resolve({
        runCliMain: () => Promise.resolve(delegatedExitCode),
      }),
    })).resolves.toBe(delegatedExitCode);
  });

  it("normalizes preload failures before loading the runtime graph", async () => {
    const root = await scratch();
    const missingRuntimeAssets = path.join(root, "private-runtime-assets");
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      VIDCOM_APP_DATA: path.join(root, "app-data"),
      VIDCOM_RUNTIME_ASSETS: missingRuntimeAssets,
    };
    let loaded = false;
    let stderr = "";

    const exitCode = await runBootstrappedCli(["version"], {
      compiler: { environment, homeDirectory: root, readSeaManifest: () => null },
      loadRuntime: () => {
        loaded = true;
        return Promise.resolve({ runCliMain: () => Promise.resolve(0) });
      },
      stderr: { write: (chunk) => { stderr += String(chunk); return true; } },
    });

    expect(exitCode).toBe(1);
    expect(loaded).toBe(false);
    expect(stderr).toBe("compiler_unavailable\n");
    expect(stderr).not.toContain(missingRuntimeAssets);
  });
});
