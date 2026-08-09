import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DOWNLOAD_CACHE_COMPONENTS,
  DownloadCacheCoordinator,
  resolveRuntimePaths,
} from "@vidcom/adapter";
import { DEFAULT_VIDCOM_SETTINGS } from "@vidcom/contracts";
import { createInfrastructure } from "@vidcom/cli";
import type { AbsolutePath } from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function captureVieNeuEnvironment(
  caBundlePath: string,
  options: { warmModels?: boolean } = {},
): Promise<Record<string, string | undefined>> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-wiring-"));
  roots.push(root);
  const appDataRoot = path.join(root, "app-data");
  const workspaceRoot = path.join(root, "workspace");
  const sidecarPath = path.join(root, "capture-sidecar.mjs");
  const capturePath = path.join(root, "environment.json");
  await mkdir(workspaceRoot, { recursive: true });
  if (options.warmModels) {
    await new DownloadCacheCoordinator({ cacheRoot: appDataRoot })
      .markReady(DOWNLOAD_CACHE_COMPONENTS.models);
  }
  await writeFile(sidecarPath, `
    import { writeFileSync } from "node:fs";
    const capturePath = process.argv[2];
    writeFileSync(capturePath, JSON.stringify({
      HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE,
      TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE,
      REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    }));
    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      ready: true,
      gpu: false,
      voices: ["Phạm Tuyên"],
      engineVersion: "3.2.4",
    }));
  `, "utf8");

  const infrastructure = createInfrastructure({
    appDataRoot,
    workspaceRoot: workspaceRoot as AbsolutePath,
    settings: {
      ...DEFAULT_VIDCOM_SETTINGS,
      runtime: { caBundlePath },
      tts: {
        ...DEFAULT_VIDCOM_SETTINGS.tts,
        vieneu: {
          ...DEFAULT_VIDCOM_SETTINGS.tts.vieneu,
          command: [process.execPath, sidecarPath, capturePath],
        },
      },
    },
  });
  try {
    await infrastructure.tts.listProviders();
    return JSON.parse(await readFile(capturePath, "utf8")) as Record<string, string | undefined>;
  } finally {
    await infrastructure.database.destroy();
  }
}

describe("production VieNeu runtime wiring", () => {
  it("repairs an incomplete markerless model directory online after its warm probe fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-repair-"));
    roots.push(root);
    const appDataRoot = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    const sidecarPath = path.join(root, "repair-sidecar.mjs");
    const observations = path.join(root, "probe-modes.jsonl");
    await mkdir(workspaceRoot, { recursive: true });
    const cache = new DownloadCacheCoordinator({ cacheRoot: appDataRoot });
    await cache.markReady(DOWNLOAD_CACHE_COMPONENTS.models);
    await writeFile(sidecarPath, `
      import { appendFileSync } from "node:fs";
      const offline = process.env.HF_HUB_OFFLINE === "1";
      appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ offline }) + "\\n");
      if (offline) process.stderr.write("offline cache is empty\\n");
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        ready: !offline,
        gpu: false,
        voices: offline ? [] : ["Phạm Tuyên"],
        engineVersion: "3.2.4",
      }));
    `, "utf8");

    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
      settings: {
        ...DEFAULT_VIDCOM_SETTINGS,
        tts: {
          ...DEFAULT_VIDCOM_SETTINGS.tts,
          vieneu: {
            ...DEFAULT_VIDCOM_SETTINGS.tts.vieneu,
            command: [process.execPath, sidecarPath],
          },
        },
      },
    });
    try {
      const providers = await infrastructure.tts.listProviders();
      expect(providers.find((provider) => provider.id === "vieneu")?.available).toBe(true);
      expect(await infrastructure.downloads.status(DOWNLOAD_CACHE_COMPONENTS.models))
        .toMatchObject({ state: "ready" });
      expect((await stat(path.join(appDataRoot, "vidcom.sqlite"))).isFile()).toBe(true);
    } finally {
      await infrastructure.database.destroy();
    }

    const modes = (await readFile(observations, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { offline: boolean });
    expect(modes).toEqual([{ offline: true }, { offline: false }]);
  });

  it.skipIf(process.platform === "win32")("does not reach a PATH Python when artifact runtime Python is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-fail-closed-"));
    roots.push(root);
    const appDataRoot = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    const fakeBin = path.join(root, "fake-bin");
    const marker = path.join(root, "path-python-ran");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(fakeBin, { recursive: true }),
    ]);
    const fakePython = path.join(fakeBin, "python3");
    await writeFile(fakePython, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
    await chmod(fakePython, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = fakeBin;
    const runtimePaths = resolveRuntimePaths({
      mode: "artifact",
      appDataRoot,
      versionRoot: path.join(appDataRoot, "native", "1.0.0"),
      archiveRoots: {
        node: path.join(appDataRoot, "native", "1.0.0", "toolchain", "native"),
        hyperframes: path.join(appDataRoot, "native", "1.0.0", "toolchain", "hyperframes"),
      },
    });
    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
      runtimePaths,
    });
    try {
      const providers = await infrastructure.tts.listProviders();
      expect(providers.find((provider) => provider.id === "vieneu")?.available).toBe(false);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await infrastructure.database.destroy();
    }
  });

  it("passes the resolved CA bundle to Node and Python children without forcing first-run offline", async () => {
    const previousHubOffline = process.env.HF_HUB_OFFLINE;
    const previousTransformersOffline = process.env.TRANSFORMERS_OFFLINE;
    delete process.env.HF_HUB_OFFLINE;
    delete process.env.TRANSFORMERS_OFFLINE;
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-ca-"));
    roots.push(root);
    const caBundlePath = path.join(root, "organisation-ca.pem");
    await writeFile(caBundlePath, "", "utf8");
    try {
      const environment = await captureVieNeuEnvironment(caBundlePath);

      expect(environment).toMatchObject({
        SSL_CERT_FILE: caBundlePath,
        REQUESTS_CA_BUNDLE: caBundlePath,
        NODE_EXTRA_CA_CERTS: caBundlePath,
      });
      expect(environment.HF_HUB_OFFLINE).toBeUndefined();
      expect(environment.TRANSFORMERS_OFFLINE).toBeUndefined();
    } finally {
      if (previousHubOffline === undefined) delete process.env.HF_HUB_OFFLINE;
      else process.env.HF_HUB_OFFLINE = previousHubOffline;
      if (previousTransformersOffline === undefined) delete process.env.TRANSFORMERS_OFFLINE;
      else process.env.TRANSFORMERS_OFFLINE = previousTransformersOffline;
    }
  });

  it("turns an explicit Hugging Face offline pass into both sidecar flags", async () => {
    const previousHubOffline = process.env.HF_HUB_OFFLINE;
    const previousTransformersOffline = process.env.TRANSFORMERS_OFFLINE;
    process.env.HF_HUB_OFFLINE = "1";
    delete process.env.TRANSFORMERS_OFFLINE;
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-offline-"));
    roots.push(root);
    const caBundlePath = path.join(root, "organisation-ca.pem");
    await writeFile(caBundlePath, "", "utf8");
    try {
      const environment = await captureVieNeuEnvironment(caBundlePath, { warmModels: true });

      expect(environment.HF_HUB_OFFLINE).toBe("1");
      expect(environment.TRANSFORMERS_OFFLINE).toBe("1");
    } finally {
      if (previousHubOffline === undefined) delete process.env.HF_HUB_OFFLINE;
      else process.env.HF_HUB_OFFLINE = previousHubOffline;
      if (previousTransformersOffline === undefined) delete process.env.TRANSFORMERS_OFFLINE;
      else process.env.TRANSFORMERS_OFFLINE = previousTransformersOffline;
    }
  });

  it("automatically turns a coordinator-ready model cache into warm-offline child flags", async () => {
    const previousHubOffline = process.env.HF_HUB_OFFLINE;
    const previousTransformersOffline = process.env.TRANSFORMERS_OFFLINE;
    delete process.env.HF_HUB_OFFLINE;
    delete process.env.TRANSFORMERS_OFFLINE;
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-auto-offline-"));
    roots.push(root);
    const caBundlePath = path.join(root, "organisation-ca.pem");
    await writeFile(caBundlePath, "", "utf8");
    try {
      const environment = await captureVieNeuEnvironment(caBundlePath, { warmModels: true });

      expect(environment.HF_HUB_OFFLINE).toBe("1");
      expect(environment.TRANSFORMERS_OFFLINE).toBe("1");
    } finally {
      if (previousHubOffline === undefined) delete process.env.HF_HUB_OFFLINE;
      else process.env.HF_HUB_OFFLINE = previousHubOffline;
      if (previousTransformersOffline === undefined) delete process.env.TRANSFORMERS_OFFLINE;
      else process.env.TRANSFORMERS_OFFLINE = previousTransformersOffline;
    }
  });
});
