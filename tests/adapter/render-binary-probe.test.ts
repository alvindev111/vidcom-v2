import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  NodeRenderBinaryProbe,
  DOWNLOAD_CACHE_COMPONENTS,
  DownloadCacheCoordinator,
  NodeProcessRunner,
  VIDCOM_NODE_SENTINEL,
  resolveChrome,
  type NodeRenderBinaryProbeOptions,
} from "@vidcom/adapter";
import { ErrorCode, WarningCode } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";

import { createChromiumExecutable } from "../support/chromium-executable";

const roots: string[] = [];
let browserFixtureRoot = "";
let browserFixture = "";
type ProbePaths = ConstructorParameters<typeof NodeRenderBinaryProbe>[0];
type FixturePaths = Required<ProbePaths>;

async function fixture(version = "0.7.86"): Promise<FixturePaths> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-binary-probe-"));
  roots.push(root);
  const paths = {
    hyperframesCliPath: path.join(root, "hyperframes.mjs") as AbsolutePath,
    hyperframesPackagePath: path.join(root, "package.json") as AbsolutePath,
    browserCacheRoot: path.join(root, DOWNLOAD_CACHE_COMPONENTS.browser) as AbsolutePath,
    browserPath: browserFixture as AbsolutePath,
    ffmpegPath: path.join(root, "ffmpeg") as AbsolutePath,
    ffprobePath: path.join(root, "ffprobe") as AbsolutePath,
  };
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(paths.hyperframesCliPath, "export {};\n"),
    writeFile(paths.hyperframesPackagePath, JSON.stringify({ version })),
    writeFile(paths.ffmpegPath, "binary"),
    writeFile(paths.ffprobePath, "binary"),
  ]);
  await Promise.all([
    chmod(paths.ffmpegPath, 0o755),
    chmod(paths.ffprobePath, 0o755),
  ]);
  return paths;
}

function projectRoot(paths: FixturePaths): AbsolutePath {
  return path.dirname(paths.hyperframesCliPath) as AbsolutePath;
}

function probeOptions(
  paths: FixturePaths,
  overrides: Partial<NodeRenderBinaryProbeOptions> = {},
): NodeRenderBinaryProbeOptions {
  return { appDataRoot: projectRoot(paths), ...overrides };
}

async function truncatedBrowser(root: AbsolutePath): Promise<AbsolutePath> {
  const target = path.join(root, process.platform === "win32" ? "chromium-truncated.exe" : "chromium-truncated");
  await writeFile(target, "\u007fELF truncated", "utf8");
  await chmod(target, 0o755);
  return target as AbsolutePath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeAll(async () => {
  browserFixtureRoot = await mkdtemp(path.join(tmpdir(), "vidcom-chromium-fixture-"));
  browserFixture = await createChromiumExecutable(browserFixtureRoot);
});

afterAll(async () => {
  await rm(browserFixtureRoot, { recursive: true, force: true });
});

describe("NodeRenderBinaryProbe", () => {
  for (const [missingName, key] of [
    ["hyperframes", "hyperframesCliPath"],
    ["chromium", "browserPath"],
    ["ffmpeg", "ffmpegPath"],
    ["ffprobe", "ffprobePath"],
  ] as const) {
    it(`reports exactly ${missingName} when its real path is absent`, async () => {
      const paths = await fixture();
      paths[key] = path.join(path.dirname(paths[key]), `missing-${missingName}`) as AbsolutePath;
      const result = await new NodeRenderBinaryProbe(paths, probeOptions(paths)).probe(projectRoot(paths));
      expect(result).toEqual({
        ok: false,
        error: {
          code: ErrorCode.RenderBinaryMissing,
          message: `render binaries are missing: ${missingName}`,
          details: { missing: [missingName] },
        },
      });
    });
  }

  it("returns usable paths and warns on a major/minor version drift", async () => {
    const paths = await fixture("0.8.0");
    const result = await new NodeRenderBinaryProbe(paths, probeOptions(paths)).probe(projectRoot(paths));
    expect(result).toMatchObject({
      ok: true,
      value: {
        hyperframesCommand: [process.execPath, paths.hyperframesCliPath],
        browserPath: paths.browserPath,
        ffmpegPath: paths.ffmpegPath,
        ffprobePath: paths.ffprobePath,
        warnings: [{ code: WarningCode.EngineVersionDrift }],
      },
    });
  });

  it("uses the SEA node sentinel when the runtime seam reports a packaged process", async () => {
    const paths = await fixture();
    const result = await new NodeRenderBinaryProbe(paths, probeOptions(paths, { isSea: () => true }))
      .probe(projectRoot(paths));

    expect(result).toMatchObject({
      ok: true,
      value: {
        hyperframesCommand: [process.execPath, VIDCOM_NODE_SENTINEL, paths.hyperframesCliPath],
      },
    });
  });

  it("accepts a CLI-reported browser only when the reported executable answers --version", async () => {
    const paths = await fixture();
    const input: ProbePaths = { ...paths };
    delete input.browserPath;
    await writeFile(
      paths.hyperframesCliPath,
      `process.stdout.write(${JSON.stringify(`${browserFixture}\n`)});\n`,
      "utf8",
    );

    const result = await new NodeRenderBinaryProbe(input, probeOptions(paths)).probe(projectRoot(paths));
    expect(result).toMatchObject({
      ok: true,
      value: { browserPath: browserFixture },
    });
  });

  it("rejects a runnable non-browser executable whose --version output has the wrong shape", async () => {
    const paths = await fixture();
    paths.browserPath = process.execPath as AbsolutePath;

    const result = await new NodeRenderBinaryProbe(paths, probeOptions(paths)).probe(projectRoot(paths));
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCode.RenderBinaryMissing, details: { missing: ["chromium"] } },
    });
  });

  it("force-repairs a ready cache whose installed browser is truncated", async () => {
    const paths = await fixture();
    const root = projectRoot(paths);
    const cache = new DownloadCacheCoordinator({ cacheRoot: root });
    const browserRoot = cache.componentRoot(DOWNLOAD_CACHE_COMPONENTS.browser) as AbsolutePath;
    paths.browserCacheRoot = browserRoot;
    const executableName = process.platform === "win32"
      ? "chrome-headless-shell.exe"
      : "chrome-headless-shell";
    const browser = path.join(
      browserRoot,
      ".cache",
      "hyperframes",
      "chrome",
      "v1",
      process.platform,
      executableName,
    );
    const invocations = path.join(root, "browser-invocations.jsonl");
    await mkdir(path.dirname(browser), { recursive: true });
    await writeFile(browser, "truncated", "utf8");
    await chmod(browser, 0o755);
    await writeFile(paths.hyperframesCliPath, `
      import { appendFile, chmod, copyFile } from "node:fs/promises";
      const args = process.argv.slice(2);
      const home = process.env.HOME ?? process.env.USERPROFILE;
      await appendFile(${JSON.stringify(invocations)}, JSON.stringify({
        args,
        home,
        telemetry: process.env.HYPERFRAMES_NO_TELEMETRY,
      }) + "\\n", "utf8");
      if (args[0] === "browser" && args[1] === "ensure" && args.includes("--force")) {
        await copyFile(${JSON.stringify(browserFixture)}, ${JSON.stringify(browser)});
        await chmod(${JSON.stringify(browser)}, 0o755);
      }
      if (args[0] === "browser" && args[1] === "path") {
        process.stdout.write(${JSON.stringify(`${browser}\n`)});
      }
    `, "utf8");
    const input: ProbePaths = { ...paths };
    delete input.browserPath;

    const result = await new NodeRenderBinaryProbe(input, {
      appDataRoot: root,
      processes: new NodeProcessRunner(30_000),
      downloadCache: cache,
      browserDownloadTimeoutMs: 30_000,
    }).probe(root);

    expect(result).toMatchObject({ ok: true, value: { browserPath: await realpath(browser) } });
    const observed = (await readFile(invocations, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; home: string; telemetry: string });
    expect(observed[0]).toEqual({
      args: ["browser", "ensure", "--force"],
      home: browserRoot,
      telemetry: "1",
    });
    expect(observed.at(-1)?.args).toEqual(["browser", "path"]);
    expect((await cache.status(DOWNLOAD_CACHE_COMPONENTS.browser)).state).toBe("ready");
  });

  it("never starts the managed download when the caller forbids it", async () => {
    const paths = await fixture();
    const root = projectRoot(paths);
    const cache = new DownloadCacheCoordinator({ cacheRoot: root });
    paths.browserCacheRoot = cache.componentRoot(DOWNLOAD_CACHE_COMPONENTS.browser) as AbsolutePath;
    const invocations = path.join(root, "browser-invocations.jsonl");
    await writeFile(paths.hyperframesCliPath, `
      import { appendFile } from "node:fs/promises";
      await appendFile(${JSON.stringify(invocations)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
    `, "utf8");
    const input: ProbePaths = { ...paths };
    delete input.browserPath;

    const result = await new NodeRenderBinaryProbe(input, {
      appDataRoot: root,
      processes: new NodeProcessRunner(30_000),
      downloadCache: cache,
      allowBrowserDownload: false,
    }).probe(root);

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCode.RenderBinaryMissing,
        message: "render binaries are missing: chromium",
        details: { missing: ["chromium"] },
      },
    });
    await expect(access(invocations)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await cache.status(DOWNLOAD_CACHE_COMPONENTS.browser)).state).toBe("missing");
  });
  it("maps a managed-browser TLS failure and leaves its marker partial", async () => {
    const paths = await fixture();
    const root = projectRoot(paths);
    const cache = new DownloadCacheCoordinator({ cacheRoot: root });
    paths.browserCacheRoot = cache.componentRoot(DOWNLOAD_CACHE_COMPONENTS.browser) as AbsolutePath;
    const input: ProbePaths = { ...paths };
    delete input.browserPath;

    const result = await new NodeRenderBinaryProbe(input, {
      appDataRoot: root,
      downloadCache: cache,
      processes: {
        run: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "SELF_SIGNED_CERT_IN_CHAIN",
          timedOut: false,
        }),
      },
      browserDownloadTimeoutMs: 5_000,
    }).probe(root);

    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCode.DownloadTlsUntrusted },
    });
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.browser)).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadTlsUntrusted,
    });
  });

  it("passes only configured app-data and CA state to the real reporter child", async () => {
    const paths = await fixture();
    const root = projectRoot(paths);
    const appDataRoot = path.join(root, "custom-app-data");
    const caBundlePath = path.join(root, "custom-ca.pem");
    const observationPath = path.join(root, "reporter-environment.json");
    const input: ProbePaths = { ...paths };
    delete input.browserPath;
    await writeFile(caBundlePath, "", "utf8");
    await writeFile(paths.hyperframesCliPath, `
      import { writeFile } from "node:fs/promises";
      await writeFile(${JSON.stringify(observationPath)}, JSON.stringify({
        appDataRoot: process.env.VIDCOM_APP_DATA ?? null,
        caBundlePath: process.env.NODE_EXTRA_CA_CERTS ?? null,
        ghKey: process.env.GH_KEY ?? null,
      }), "utf8");
      process.stdout.write(${JSON.stringify(`${browserFixture}\n`)});
    `, "utf8");
    const previousGhKey = process.env.GH_KEY;
    process.env.GH_KEY = "must-not-reach-render-children";
    try {
      const result = await new NodeRenderBinaryProbe(input, {
        appDataRoot,
        caBundlePath,
      }).probe(root);
      expect(result.ok).toBe(true);
    } finally {
      if (previousGhKey === undefined) delete process.env.GH_KEY;
      else process.env.GH_KEY = previousGhKey;
    }

    expect(JSON.parse(await readFile(observationPath, "utf8"))).toEqual({
      appDataRoot,
      caBundlePath,
      ghKey: null,
    });
  });

  it("rejects a CLI-managed runnable browser outside the coordinated cache", async () => {
    const paths = await fixture();
    const root = projectRoot(paths);
    const cache = new DownloadCacheCoordinator({ cacheRoot: root });
    paths.browserCacheRoot = cache.componentRoot(DOWNLOAD_CACHE_COMPONENTS.browser) as AbsolutePath;
    const input: ProbePaths = { ...paths };
    delete input.browserPath;
    await writeFile(paths.hyperframesCliPath, `
      const args = process.argv.slice(2);
      if (args[0] === "browser" && args[1] === "path") {
        process.stdout.write(${JSON.stringify(`${browserFixture}\n`)});
      }
    `, "utf8");

    const result = await new NodeRenderBinaryProbe(input, {
      appDataRoot: root,
      processes: new NodeProcessRunner(30_000),
      downloadCache: cache,
      browserDownloadTimeoutMs: 30_000,
    }).probe(root);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.DownloadUnavailable } });
    expect(await cache.status(DOWNLOAD_CACHE_COMPONENTS.browser)).toMatchObject({
      state: "partial",
      failureCode: ErrorCode.DownloadUnavailable,
    });
  });

  it.skipIf(process.platform === "win32")("does not follow a managed browser symlink outside its cache", async () => {
    const paths = await fixture();
    const managedRoot = paths.browserCacheRoot;
    const candidate = path.join(managedRoot, "v1", "linux", "chrome-headless-shell");
    await mkdir(path.dirname(candidate), { recursive: true });
    await symlink(browserFixture, candidate, "file");

    await expect(resolveChrome({ browserCacheRoot: managedRoot })).resolves.toBeNull();
  });

  it.each(["supplied", "CLI-reported"] as const)(
    "rejects an executable-but-truncated %s browser",
    async (source) => {
      const paths = await fixture();
      const root = projectRoot(paths);
      const broken = await truncatedBrowser(root);
      await access(broken, constants.X_OK);
      const input: ProbePaths = { ...paths };
      if (source === "supplied") {
        input.browserPath = broken;
      } else {
        delete input.browserPath;
        await writeFile(
          paths.hyperframesCliPath,
          `process.stdout.write(${JSON.stringify(`${broken}\n`)});\n`,
          "utf8",
        );
      }

      const result = await new NodeRenderBinaryProbe(input, probeOptions(paths)).probe(root);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: ErrorCode.RenderBinaryMissing,
          details: { missing: ["chromium"] },
        },
      });
    },
  );

  it("surfaces project version skew without changing hyperframes.json", async () => {
    const paths = await fixture();
    const root = projectRoot(paths);
    const manifest = "{\n  \"hyperframes\": \"0.6.0\"\n}\n";
    const manifestPath = path.join(root, "hyperframes.json");
    await writeFile(manifestPath, manifest, "utf8");

    const result = await new NodeRenderBinaryProbe(paths, probeOptions(paths)).probe(root);
    expect(result).toMatchObject({
      ok: true,
      value: {
        warnings: [{
          code: WarningCode.EngineVersionDrift,
          message: expect.stringContaining("declares HyperFrames 0.6.0"),
        }],
      },
    });
    expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  });

  it("does not report project skew when the declared version exactly matches", async () => {
    const paths = await fixture();
    const root = projectRoot(paths);
    await writeFile(path.join(root, "hyperframes.json"), JSON.stringify({ version: "0.7.86" }), "utf8");

    const result = await new NodeRenderBinaryProbe(paths, probeOptions(paths)).probe(root);
    expect(result).toMatchObject({ ok: true, value: { warnings: [] } });
  });
});
