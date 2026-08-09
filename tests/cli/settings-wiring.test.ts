import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultAppDataRoot } from "@vidcom/cli";
import { DEFAULT_VIDCOM_SETTINGS, resolveVidcomSettings } from "@vidcom/contracts";

const roots: string[] = [];
const savedAppData = process.env.VIDCOM_APP_DATA;

afterEach(async () => {
  if (savedAppData === undefined) delete process.env.VIDCOM_APP_DATA;
  else process.env.VIDCOM_APP_DATA = savedAppData;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("appDataRoot precedence", () => {
  it("lets the settings file redirect application data", async () => {
    delete process.env.VIDCOM_APP_DATA;
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-appdata-"));
    roots.push(root);

    expect(defaultAppDataRoot(resolveVidcomSettings({ appDataRoot: root }))).toBe(root);
  });

  it("lets the environment override the settings file", async () => {
    const fromEnvironment = await mkdtemp(path.join(tmpdir(), "vidcom-env-"));
    const fromFile = await mkdtemp(path.join(tmpdir(), "vidcom-file-"));
    roots.push(fromEnvironment, fromFile);
    process.env.VIDCOM_APP_DATA = fromEnvironment;

    // An operator has to be able to redirect one run without editing the file.
    expect(defaultAppDataRoot(resolveVidcomSettings({ appDataRoot: fromFile }))).toBe(fromEnvironment);
  });

  it("falls back to the platform convention when neither says otherwise", () => {
    delete process.env.VIDCOM_APP_DATA;

    // An existing install must keep its database when a settings file appears.
    const platformDefault = defaultAppDataRoot();
    expect(defaultAppDataRoot(DEFAULT_VIDCOM_SETTINGS)).toBe(platformDefault);
    expect(path.isAbsolute(platformDefault)).toBe(true);
  });

  it("pins settings before the source launcher opens a legacy command database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-launcher-settings-"));
    roots.push(root);
    const settingsRoot = path.join(root, "settings-app-data");
    const fakeHome = path.join(root, "platform-home");
    const settingsPath = path.join(root, "setting.json");
    await writeFile(settingsPath, JSON.stringify({ appDataRoot: settingsRoot }));

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: path.join(root, "platform-roaming"),
      HOME: fakeHome,
      VIDCOM_SETTINGS: settingsPath,
    };
    delete environment.VIDCOM_APP_DATA;
    const platformDefault = defaultAppDataRoot(undefined, {
      environment,
      homeDirectory: fakeHome,
    });
    expect(platformDefault).not.toBe(settingsRoot);

    const result = spawnSync(process.execPath, [
      "packages/cli/bin/vidcom.mjs",
      "credential",
      "list",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ credentials: [] });
    expect((await stat(path.join(settingsRoot, "vidcom.sqlite"))).isFile()).toBe(true);
    await expect(access(platformDefault)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
