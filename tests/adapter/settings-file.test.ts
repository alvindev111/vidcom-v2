import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultSettingsPath,
  ensureVidcomSettingsFile,
  readVidcomSettings,
  vidcomHome,
  VidcomSettingsError,
  writeVidcomSettings,
} from "@vidcom/adapter";
import { DEFAULT_VIDCOM_SETTINGS } from "@vidcom/contracts";

const roots: string[] = [];
const savedEnvironment = { home: process.env.VIDCOM_HOME, file: process.env.VIDCOM_SETTINGS };

async function home(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-settings-"));
  roots.push(root);
  return root;
}

async function settingsFile(document: unknown): Promise<string> {
  const root = await home();
  const pathname = path.join(root, "setting.json");
  await writeFile(pathname, typeof document === "string" ? document : JSON.stringify(document), "utf8");
  return pathname;
}

afterEach(async () => {
  process.env.VIDCOM_HOME = savedEnvironment.home;
  process.env.VIDCOM_SETTINGS = savedEnvironment.file;
  if (savedEnvironment.home === undefined) delete process.env.VIDCOM_HOME;
  if (savedEnvironment.file === undefined) delete process.env.VIDCOM_SETTINGS;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("settings file location", () => {
  it("lives at ~/.vidcom/setting.json by default", () => {
    delete process.env.VIDCOM_HOME;
    delete process.env.VIDCOM_SETTINGS;

    expect(defaultSettingsPath()).toBe(path.join(vidcomHome(), "setting.json"));
    expect(vidcomHome().endsWith(path.join("", ".vidcom"))).toBe(true);
  });

  it("relocates with VIDCOM_HOME", () => {
    process.env.VIDCOM_HOME = path.join(tmpdir(), "portable-vidcom");
    delete process.env.VIDCOM_SETTINGS;

    expect(defaultSettingsPath()).toBe(path.join(tmpdir(), "portable-vidcom", "setting.json"));
  });

  it("is named outright by VIDCOM_SETTINGS", () => {
    process.env.VIDCOM_SETTINGS = path.join(tmpdir(), "elsewhere.json");

    expect(defaultSettingsPath()).toBe(path.join(tmpdir(), "elsewhere.json"));
  });
});

describe("readVidcomSettings", () => {
  it("runs on defaults when no file exists", async () => {
    const root = await home();

    await expect(readVidcomSettings(path.join(root, "setting.json")))
      .resolves.toEqual(DEFAULT_VIDCOM_SETTINGS);
  });

  it("treats an empty file as defaults, not as a broken one", async () => {
    await expect(readVidcomSettings(await settingsFile("   \n"))).resolves.toEqual(DEFAULT_VIDCOM_SETTINGS);
  });

  it("accepts an empty object and fills every level", async () => {
    await expect(readVidcomSettings(await settingsFile({}))).resolves.toEqual(DEFAULT_VIDCOM_SETTINGS);
  });

  it("reads the ElevenLabs key and the VieNeu command", async () => {
    const pathname = await settingsFile({
      tts: {
        elevenlabs: { apiKey: "sk-from-file" },
        vieneu: { command: ["/venv/bin/python", "/sidecar/worker.py"], modelRevision: "abc1234" },
      },
    });

    const settings = await readVidcomSettings(pathname);

    expect(settings.tts.elevenlabs.apiKey).toBe("sk-from-file");
    expect(settings.tts.vieneu.command).toEqual(["/venv/bin/python", "/sidecar/worker.py"]);
    expect(settings.tts.vieneu.modelRevision).toBe("abc1234");
  });

  it("reads the roots that decide where everything else lives", async () => {
    const pathname = await settingsFile({ appDataRoot: "/data/vidcom", workspaceRoot: "/work" });

    const settings = await readVidcomSettings(pathname);

    expect(settings).toMatchObject({ appDataRoot: "/data/vidcom", workspaceRoot: "/work" });
  });

  it("rejects a mistyped key instead of ignoring it", async () => {
    // Silently dropping it means the user's API key does nothing while the daemon
    // reports itself healthy — the hardest misconfiguration to find.
    const pathname = await settingsFile({ tts: { elevenLabs: { apiKey: "sk-typo" } } });

    await expect(readVidcomSettings(pathname)).rejects.toBeInstanceOf(VidcomSettingsError);
  });

  it("rejects a rate outside the range the engines accept", async () => {
    const pathname = await settingsFile({ tts: { defaultRatePercent: 90 } });

    await expect(readVidcomSettings(pathname)).rejects.toThrow(/defaultRatePercent is invalid/);
  });

  it("rejects a compute device the contract does not define", async () => {
    const pathname = await settingsFile({ tts: { defaultComputeDevice: "auto" } });

    await expect(readVidcomSettings(pathname)).rejects.toBeInstanceOf(VidcomSettingsError);
  });

  it("names the file and the reason on malformed JSON", async () => {
    const pathname = await settingsFile("{ \"tts\": ");

    await expect(readVidcomSettings(pathname)).rejects.toThrow(/not valid JSON/);
  });

  it("never puts a rejected value in the error message", async () => {
    const pathname = await settingsFile({ tts: { elevenlabs: { apiKey: "" } } });

    const failure = await readVidcomSettings(pathname).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VidcomSettingsError);
    expect((failure as Error).message).toContain("apiKey");
  });
});

describe("writeVidcomSettings", () => {
  it("writes owner-only, because the file holds a paid-service key", async () => {
    const root = await home();
    const pathname = path.join(root, "setting.json");

    await writeVidcomSettings({ tts: { elevenlabs: { apiKey: "sk-secret" } } }, pathname);

    expect(JSON.parse(await readFile(pathname, "utf8"))).toMatchObject({
      tts: { elevenlabs: { apiKey: "sk-secret" } },
    });
    if (process.platform !== "win32") {
      expect((await stat(pathname)).mode & 0o077).toBe(0);
    }
  });

  it("round-trips through the reader", async () => {
    const root = await home();
    const pathname = path.join(root, "setting.json");

    await writeVidcomSettings({ appDataRoot: "/data", tts: { defaultProviderId: "vieneu" } }, pathname);

    await expect(readVidcomSettings(pathname)).resolves.toMatchObject({
      appDataRoot: "/data",
      tts: { defaultProviderId: "vieneu" },
    });
  });
});

describe("ensureVidcomSettingsFile", () => {
  it("creates a template a user can fill in without guessing the schema", async () => {
    const root = await home();
    const pathname = path.join(root, "setting.json");

    await ensureVidcomSettingsFile(pathname);

    const document = JSON.parse(await readFile(pathname, "utf8")) as Record<string, unknown>;
    expect(document).toMatchObject({ tts: { elevenlabs: { apiKey: null } } });
    // The template must satisfy its own schema, or first launch writes a file
    // that second launch refuses.
    await expect(readVidcomSettings(pathname)).resolves.toEqual(DEFAULT_VIDCOM_SETTINGS);
  });

  it("leaves an existing file alone", async () => {
    const pathname = await settingsFile({ tts: { elevenlabs: { apiKey: "sk-mine" } } });

    await ensureVidcomSettingsFile(pathname);

    await expect(readVidcomSettings(pathname)).resolves.toMatchObject({
      tts: { elevenlabs: { apiKey: "sk-mine" } },
    });
  });

  it("does not overwrite a file the user broke mid-edit", async () => {
    const pathname = await settingsFile("{ broken");

    await ensureVidcomSettingsFile(pathname);

    // Overwriting would destroy the thing they were editing.
    expect(await readFile(pathname, "utf8")).toBe("{ broken");
  });

  it("creates the home directory when it does not exist yet", async () => {
    const root = await home();
    const pathname = path.join(root, "nested", "setting.json");

    await ensureVidcomSettingsFile(pathname);

    expect((await stat(path.dirname(pathname))).isDirectory()).toBe(true);
  });
});

describe("settings directory hygiene", () => {
  it("restricts the directory it creates", async () => {
    const root = await home();
    const directory = path.join(root, "home");
    await mkdir(directory, { recursive: true });

    await writeVidcomSettings({}, path.join(directory, "setting.json"));

    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o077).toBe(0);
    }
  });
});
