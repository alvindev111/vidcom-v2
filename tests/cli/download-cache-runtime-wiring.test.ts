import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DOWNLOAD_CACHE_COMPONENTS,
  DownloadCacheCoordinator,
  RuntimeAssetError,
  resolveRuntimePaths,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { createDoctorContext, createInfrastructure } from "@vidcom/cli";
import type { AbsolutePath } from "@vidcom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChromiumExecutable } from "../support/chromium-executable";

const roots: string[] = [];
const inheritedChromePath = process.env.CHROME_PATH;

beforeEach(() => {
  delete process.env.CHROME_PATH;
});

afterEach(async () => {
  if (inheritedChromePath === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = inheritedChromePath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production download-cache runtime wiring", () => {
  it("honors CHROME_PATH in source infrastructure without a managed browser download", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-source-browser-override-"));
    roots.push(root);
    const appDataRoot = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace") as AbsolutePath;
    const projectRoot = path.join(workspaceRoot, "project") as AbsolutePath;
    const browser = await createChromiumExecutable(root);
    const ffmpeg = path.join(root, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") as AbsolutePath;
    const ffprobe = path.join(root, process.platform === "win32" ? "ffprobe.exe" : "ffprobe") as AbsolutePath;
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      writeFile(ffmpeg, "binary", "utf8"),
      writeFile(ffprobe, "binary", "utf8"),
    ]);
    await Promise.all([chmod(ffmpeg, 0o755), chmod(ffprobe, 0o755)]);

    const previousChromePath = process.env.CHROME_PATH;
    process.env.CHROME_PATH = browser;
    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot,
      runtimePaths: resolveRuntimePaths({ mode: "development", appDataRoot }),
      renderBinaryPaths: { ffmpegPath: ffmpeg, ffprobePath: ffprobe },
      processes: {
        run: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "managed download must not run when CHROME_PATH is set",
          timedOut: false,
        }),
      },
    });
    try {
      expect(await infrastructure.renderBinaries.probe(projectRoot)).toMatchObject({
        ok: true,
        value: { browserPath: browser },
      });
      expect(await infrastructure.downloads.status(DOWNLOAD_CACHE_COMPONENTS.browser))
        .toMatchObject({ state: "missing" });
    } finally {
      if (previousChromePath === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = previousChromePath;
      await infrastructure.database.destroy();
    }
  });

  it("downloads Chromium into RuntimePaths.browserCacheRoot and reuses it after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-browser-wiring-"));
    roots.push(root);
    const appDataRoot = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace") as AbsolutePath;
    const projectRoot = path.join(root, "project") as AbsolutePath;
    const versionRoot = path.join(appDataRoot, "native", "1.0.0");
    const hyperframesRoot = path.join(versionRoot, "hyperframes");
    const nativeRoot = path.join(versionRoot, "node");
    const runtimePaths = resolveRuntimePaths({
      mode: "artifact",
      appDataRoot,
      versionRoot,
      archiveRoots: { hyperframes: hyperframesRoot, node: nativeRoot },
    });
    const executableName = process.platform === "win32"
      ? "chrome-headless-shell.exe"
      : "chrome-headless-shell";
    const browser = path.join(
      runtimePaths.browserCacheRoot,
      ".cache",
      "hyperframes",
      "chrome",
      "v1",
      process.platform,
      executableName,
    );
    const observations = path.join(root, "browser-children.jsonl");
    const browserFixture = await createChromiumExecutable(root);
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(path.dirname(runtimePaths.hyperframesCliPath), { recursive: true }),
      mkdir(path.dirname(path.join(nativeRoot, "bin", "ffmpeg")), { recursive: true }),
    ]);
    await writeFile(runtimePaths.hyperframesPackagePath, JSON.stringify({ version: "0.7.86" }), "utf8");
    await writeFile(runtimePaths.hyperframesCliPath, `
      import { appendFile, chmod, copyFile, mkdir } from "node:fs/promises";
      const args = process.argv.slice(2);
      await appendFile(${JSON.stringify(observations)}, JSON.stringify({
        args,
        home: process.env.HOME ?? process.env.USERPROFILE,
        appData: process.env.VIDCOM_APP_DATA,
      }) + "\\n", "utf8");
      if (args[0] === "browser" && args[1] === "ensure") {
        await mkdir(${JSON.stringify(path.dirname(browser))}, { recursive: true });
        await copyFile(${JSON.stringify(browserFixture)}, ${JSON.stringify(browser)});
        await chmod(${JSON.stringify(browser)}, 0o755);
      }
      if (args[0] === "browser" && args[1] === "path") {
        process.stdout.write(${JSON.stringify(`${browser}\n`)});
      }
    `, "utf8");
    const suffix = process.platform === "win32" ? ".exe" : "";
    const ffmpeg = path.join(nativeRoot, "bin", `ffmpeg${suffix}`);
    const ffprobe = path.join(nativeRoot, "bin", `ffprobe${suffix}`);
    await Promise.all([
      writeFile(ffmpeg, "binary", "utf8"),
      writeFile(ffprobe, "binary", "utf8"),
    ]);
    await Promise.all([chmod(ffmpeg, 0o755), chmod(ffprobe, 0o755)]);

    const first = createInfrastructure({ appDataRoot, workspaceRoot, runtimePaths });
    try {
      const result = await first.renderBinaries.probe(projectRoot);
      expect(result).toMatchObject({ ok: true, value: { browserPath: await realpath(browser) } });
      expect((await stat(path.join(appDataRoot, "vidcom.sqlite"))).isFile()).toBe(true);
      expect(await first.downloads.status(DOWNLOAD_CACHE_COMPONENTS.browser))
        .toMatchObject({ state: "ready" });
    } finally {
      await first.database.destroy();
    }

    const coldInvocations = (await readFile(observations, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; home: string; appData: string });
    expect(coldInvocations.map(({ args }) => args)).toEqual([
      ["browser", "ensure"],
      ["browser", "path"],
    ]);
    expect(coldInvocations.every(({ home }) => home === runtimePaths.browserCacheRoot)).toBe(true);
    expect(coldInvocations.every(({ appData }) => appData === appDataRoot)).toBe(true);

    const reopened = createInfrastructure({ appDataRoot, workspaceRoot, runtimePaths });
    try {
      const result = await reopened.renderBinaries.probe(projectRoot);
      expect(result).toMatchObject({ ok: true, value: { browserPath: await realpath(browser) } });
    } finally {
      await reopened.database.destroy();
    }
    expect((await readFile(observations, "utf8")).trim().split("\n")).toHaveLength(2);

    const authority = new DownloadCacheCoordinator({ cacheRoot: appDataRoot });
    expect(authority.componentRoot(DOWNLOAD_CACHE_COMPONENTS.browser))
      .toBe(runtimePaths.browserCacheRoot);
  });

  it("reports persisted browser and model download failures through doctor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-download-doctor-"));
    roots.push(root);
    const appDataRoot = path.join(root, "app-data");
    const cache = new DownloadCacheCoordinator({ cacheRoot: appDataRoot });
    for (const component of [
      DOWNLOAD_CACHE_COMPONENTS.browser,
      DOWNLOAD_CACHE_COMPONENTS.models,
    ]) {
      await cache.download(component, () => Promise.reject(new RuntimeAssetError(
        ErrorCode.DownloadTlsUntrusted,
        "fixture TLS failure",
        { component },
      )), 5_000).catch(() => undefined);
    }

    const context = await createDoctorContext({
      deep: false,
      appDataRoot,
      runtimePaths: resolveRuntimePaths({ mode: "development", appDataRoot }),
    });
    try {
      expect(await context.probes.chromeCache()).toMatchObject({
        ok: false,
        detail: expect.stringContaining(ErrorCode.DownloadTlsUntrusted),
      });
      expect(await context.probes.ttsModelCache()).toMatchObject({
        ok: false,
        detail: expect.stringContaining(ErrorCode.DownloadTlsUntrusted),
      });
      expect((await stat(path.join(appDataRoot, "vidcom.sqlite"))).isFile()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("does not call an empty markerless model directory healthy without a warm-offline probe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-model-doctor-"));
    roots.push(root);
    const appDataRoot = path.join(root, "app-data");
    const settingsPath = path.join(root, "setting.json");
    const sidecarPath = path.join(root, "offline-probe.mjs");
    const observationPath = path.join(root, "offline-environment.json");
    const cache = new DownloadCacheCoordinator({ cacheRoot: appDataRoot });
    await cache.markReady(DOWNLOAD_CACHE_COMPONENTS.models);
    await writeFile(sidecarPath, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
        hub: process.env.HF_HUB_OFFLINE,
        transformers: process.env.TRANSFORMERS_OFFLINE,
      }));
      process.stderr.write("offline cache is empty\\n");
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        ready: false,
        gpu: false,
        voices: [],
        engineVersion: "3.2.4",
      }));
    `, "utf8");
    await writeFile(settingsPath, JSON.stringify({
      tts: { vieneu: { command: [process.execPath, sidecarPath] } },
    }), "utf8");
    const previousSettings = process.env.VIDCOM_SETTINGS;
    process.env.VIDCOM_SETTINGS = settingsPath;
    let context: Awaited<ReturnType<typeof createDoctorContext>> | undefined;
    try {
      context = await createDoctorContext({
        deep: false,
        appDataRoot,
        runtimePaths: resolveRuntimePaths({ mode: "development", appDataRoot }),
      });
      expect(await context.probes.ttsModelCache()).toMatchObject({
        ok: false,
        detail: expect.stringContaining(ErrorCode.DownloadUnavailable),
      });
      expect(JSON.parse(await readFile(observationPath, "utf8"))).toEqual({
        hub: "1",
        transformers: "1",
      });
      expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.models)).toMatchObject({
        state: "partial",
        failureCode: ErrorCode.DownloadUnavailable,
      });
      expect((await stat(path.join(appDataRoot, "vidcom.sqlite"))).isFile()).toBe(true);
    } finally {
      if (previousSettings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = previousSettings;
      await context?.close();
    }
  });
});
