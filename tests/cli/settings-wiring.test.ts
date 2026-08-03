import { mkdtemp, rm } from "node:fs/promises";
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
});
