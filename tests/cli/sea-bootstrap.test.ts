import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Module } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MOTION_LIBRARIES } from "@vidcom/contracts";
import {
  ErrorCode,
  PACKAGED_RUNTIME_MIGRATION_ENTRIES,
  RuntimeAssetError,
  type EmbeddedRuntimeManifest,
} from "@vidcom/adapter/runtime-bootstrap";
import {
  runSeaBootstrap,
  SEA_BOOT_RELATIVE_PATH,
} from "../../packages/cli/src/sea-bootstrap";
import {
  archiveFor,
  HOST_SUPPORTED,
  HOST_TAG,
  productRuntimeFixtureEntries,
  runtimeManifest,
  type FixtureFile,
} from "../support/runtime-fixture";

const ARTIFACT_VERSION = "sea-bootstrap-test-1.0.0";
const NODE_ARCHIVE_KEY = "node";
const NODE_ARCHIVE_TARGET = "node";
const HYPERFRAMES_ARCHIVE_KEY = "hyperframes";
const HYPERFRAMES_ARCHIVE_TARGET = "hyperframes";
const BGM_ARCHIVE_KEY = "bgm";
const BGM_ARCHIVE_TARGET = "bgm";
const MANIFEST_ASSET = "runtime-manifest.json";
const NODE_ARCHIVE_ASSET = `runtime-archives/${NODE_ARCHIVE_KEY}.tar.gz`;
const HYPERFRAMES_ARCHIVE_ASSET = `runtime-archives/${HYPERFRAMES_ARCHIVE_KEY}.tar.gz`;
const BGM_ARCHIVE_ASSET = `runtime-archives/${BGM_ARCHIVE_KEY}.tar.gz`;
const BGM_FILES = [
  "alex-morgan-corporate-business-background.mp3",
  "corporate-marimba-business-background.mp3",
  "meta.mp3",
  "promo-promo-business-background.mp3",
].map((entry) => ({ path: entry, content: Buffer.from(`fixture ${entry}\n`) }));
const MIGRATION_PATHS = PACKAGED_RUNTIME_MIGRATION_ENTRIES;
const BOOT_BODY = Buffer.from(
  `"use strict";\nmodule.exports = { runBootstrappedCli: async (argv) => 40 + argv.length };\n`,
  "utf8",
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix = "vidcom-sea-bootstrap-"): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

interface RuntimeFixture {
  artifactVersion: string;
  archives: Readonly<Record<string, Buffer>>;
  manifestBytes: Buffer;
}

interface NodeModuleWithInitPaths {
  _initPaths(): void;
}

function fixture(options: {
  artifactVersion?: string;
  bootBody?: Buffer;
  nodeFiles?: readonly FixtureFile[];
  hyperframesFiles?: readonly FixtureFile[];
  includeHyperframes?: boolean;
  omitNodeEntries?: readonly string[];
  omitHyperframesEntries?: readonly string[];
  versionOverrides?: Partial<Omit<EmbeddedRuntimeManifest["versions"], "motion">> & {
    motion?: Partial<EmbeddedRuntimeManifest["versions"]["motion"]>;
  };
} = {}): RuntimeFixture {
  const artifactVersion = options.artifactVersion ?? ARTIFACT_VERSION;
  const product = productRuntimeFixtureEntries(MIGRATION_PATHS.map((migrationPath) => ({
    path: migrationPath,
    content: Buffer.from("CREATE TABLE fixture (id INTEGER);\n"),
  })));
  const omitNode = new Set(options.omitNodeEntries);
  const omitHyperframes = new Set(options.omitHyperframesEntries);
  const hyperframesOverrides = new Set(options.hyperframesFiles?.map((file) => file.path));
  const node = archiveFor(
    NODE_ARCHIVE_KEY,
    [
      { path: SEA_BOOT_RELATIVE_PATH, content: options.bootBody ?? BOOT_BODY },
      ...product.node,
      ...product.native,
      ...(options.nodeFiles ?? []),
    ].filter((file) => !omitNode.has(file.path)),
    undefined,
    NODE_ARCHIVE_TARGET,
  );
  const hyperframes = archiveFor(
    HYPERFRAMES_ARCHIVE_KEY,
    [
      ...product.hyperframes.filter((file) => !hyperframesOverrides.has(file.path)),
      ...product.native.filter((file) => !hyperframesOverrides.has(file.path)),
      ...(options.hyperframesFiles ?? []),
    ]
      .filter((file) => !omitHyperframes.has(file.path)),
    undefined,
    HYPERFRAMES_ARCHIVE_TARGET,
  );
  const bgm = archiveFor(
    BGM_ARCHIVE_KEY,
    BGM_FILES,
    undefined,
    BGM_ARCHIVE_TARGET,
  );
  const includeHyperframes = options.includeHyperframes !== false;
  const baseManifest = runtimeManifest(
    artifactVersion,
    [bgm.archive, node.archive, ...(includeHyperframes ? [hyperframes.archive] : [])],
  );
  const manifest = options.versionOverrides
    ? {
        ...baseManifest,
        versions: {
          ...baseManifest.versions,
          ...options.versionOverrides,
          motion: {
            ...baseManifest.versions.motion,
            ...options.versionOverrides.motion,
          },
        },
      }
    : baseManifest;
  return {
    artifactVersion,
    archives: {
      [BGM_ARCHIVE_KEY]: bgm.bytes,
      [NODE_ARCHIVE_KEY]: node.bytes,
      ...(includeHyperframes ? { [HYPERFRAMES_ARCHIVE_KEY]: hyperframes.bytes } : {}),
    },
    manifestBytes: Buffer.from(JSON.stringify(manifest), "utf8"),
  };
}

function rawAssets(
  runtime: RuntimeFixture,
  calls: string[],
  allowArchive = true,
): (key: string) => ArrayBuffer {
  return (key) => {
    calls.push(key);
    if (key === MANIFEST_ASSET) return arrayBuffer(runtime.manifestBytes);
    if (allowArchive && key.startsWith("runtime-archives/") && key.endsWith(".tar.gz")) {
      const archiveKey = key.slice("runtime-archives/".length, -".tar.gz".length);
      const bytes = runtime.archives[archiveKey];
      if (bytes) return arrayBuffer(bytes);
    }
    throw new Error(`unexpected SEA asset read: ${key}`);
  };
}

function installedBootPath(appDataRoot: string, artifactVersion = ARTIFACT_VERSION): string {
  return path.join(
    appDataRoot,
    "native",
    artifactVersion,
    NODE_ARCHIVE_TARGET,
    ...SEA_BOOT_RELATIVE_PATH.split("/"),
  );
}

async function isDirectory(pathname: string): Promise<boolean> {
  return lstat(pathname).then((metadata) => metadata.isDirectory(), () => false);
}

describe.skipIf(!HOST_SUPPORTED)("primary SEA bootstrap", () => {
  it("extracts a real tar archive, verifies boot.cjs and delegates arguments", async () => {
    const appDataRoot = await temporaryRoot();
    const runtime = fixture();
    const calls: string[] = [];

    await expect(runSeaBootstrap(["version", "--json"], {
      appDataRoot,
      rawAsset: rawAssets(runtime, calls),
    })).resolves.toBe(42);

    expect(calls).toEqual([
      MANIFEST_ASSET,
      BGM_ARCHIVE_ASSET,
      NODE_ARCHIVE_ASSET,
      HYPERFRAMES_ARCHIVE_ASSET,
    ]);
    expect(await readFile(installedBootPath(appDataRoot))).toEqual(BOOT_BODY);
    const metadata = await lstat(installedBootPath(appDataRoot));
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.nlink).toBe(1);
  });

  it.each([1, 130])("preserves delegated CLI exit code %i", async (delegatedExitCode) => {
    const appDataRoot = await temporaryRoot();
    const runtime = fixture({
      bootBody: Buffer.from(
        `"use strict";\nmodule.exports = { runBootstrappedCli: async () => ${delegatedExitCode} };\n`,
        "utf8",
      ),
    });

    await expect(runSeaBootstrap(["render"], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    })).resolves.toBe(delegatedExitCode);
  });

  it("reuses a warm real-filesystem installation without reading archive bytes", async () => {
    const appDataRoot = await temporaryRoot();
    const runtime = fixture();
    await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    });
    const warmCalls: string[] = [];

    await expect(runSeaBootstrap(["doctor"], {
      appDataRoot,
      rawAsset: rawAssets(runtime, warmCalls, false),
    })).resolves.toBe(41);
    expect(warmCalls).toEqual([MANIFEST_ASSET]);
  });

  it("rejects a warm boot file whose bytes no longer match the manifest", async () => {
    const appDataRoot = await temporaryRoot();
    const runtime = fixture();
    await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    });
    await writeFile(installedBootPath(appDataRoot), "module.exports = {};\n", "utf8");

    await expect(runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, [], false),
    })).rejects.toThrow("does not match its manifest hash");
  });

  it("rejects a symbolic-link directory between the node archive and boot.cjs", async () => {
    const appDataRoot = await temporaryRoot();
    const outsideRoot = await temporaryRoot("vidcom-sea-bootstrap-outside-");
    const runtime = fixture();
    await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    });
    const cliRoot = path.dirname(installedBootPath(appDataRoot));
    const outsideCli = path.join(outsideRoot, "cli");
    await mkdir(outsideCli, { recursive: true });
    await writeFile(path.join(outsideCli, "boot.cjs"), BOOT_BODY);
    await rm(cliRoot, { recursive: true });
    await symlink(outsideCli, cliRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, [], false),
    })).rejects.toThrow("contains a symbolic link");
  });

  it("rejects a hard-linked boot.cjs even when its hash is valid", async () => {
    const appDataRoot = await temporaryRoot();
    const runtime = fixture();
    await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    });
    await link(installedBootPath(appDataRoot), path.join(appDataRoot, "boot-copy.cjs"));

    await expect(runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, [], false),
    })).rejects.toThrow("singly-linked regular file");
  });

  it("requires the verified secondary module to export runBootstrappedCli", async () => {
    const appDataRoot = await temporaryRoot();
    const runtime = fixture({ bootBody: Buffer.from("module.exports = {};\n", "utf8") });

    await expect(runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    })).rejects.toThrow("does not export runBootstrappedCli");
  });

  it("resolves a transitive external graph contained by the node archive", async () => {
    const appDataRoot = await temporaryRoot();
    const bootBody = Buffer.from(
      `"use strict";\nconst dependency = require("sea-bootstrap-outer");\n`
      + `module.exports = { runBootstrappedCli: async () => dependency.exitCode };\n`,
      "utf8",
    );
    const runtime = fixture({ bootBody, nodeFiles: [{
      path: "cli/node_modules/sea-bootstrap-outer/index.js",
      content: Buffer.from('module.exports = require("sea-bootstrap-inner");\n', "utf8"),
    }, {
      path: "cli/node_modules/sea-bootstrap-inner/index.js",
      content: Buffer.from("module.exports = { exitCode: 73 };\n", "utf8"),
    }] });

    await expect(runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    })).resolves.toBe(73);
  });

  it("imports the same-generation HyperFrames --version entry with no lookup fallback", async () => {
    const appDataRoot = await temporaryRoot();
    const signal = "__vidcomSeaHyperframesVersion";
    const bootBody = Buffer.from(
      `"use strict";\nconst path = require("node:path");\n`
      + `const { pathToFileURL } = require("node:url");\n`
      + "module.exports = { runBootstrappedCli: async (argv) => {\n"
      + `  const script = path.resolve(__dirname, "../../hyperframes/bin/hyperframes.mjs");\n`
      + "  const original = process.argv;\n"
      + "  process.argv = [process.execPath, script, ...argv];\n"
      + `  try { await import(pathToFileURL(script).href); return globalThis[${JSON.stringify(signal)}] === "0.7.86" ? 86 : 1; }\n`
      + "  finally { process.argv = original; }\n"
      + "} };\n",
      "utf8",
    );
    const runtime = fixture({
      bootBody,
      hyperframesFiles: [{
        path: "bin/hyperframes.mjs",
        content: Buffer.from(
          `if (process.argv[2] === "--version") globalThis[${JSON.stringify(signal)}] = "0.7.86";\n`,
          "utf8",
        ),
      }],
    });
    const nodeModule = Module as unknown as NodeModuleWithInitPaths;
    const originalPath = process.env.PATH;
    const originalNodePath = process.env.NODE_PATH;
    try {
      process.env.PATH = "";
      delete process.env.NODE_PATH;
      nodeModule._initPaths();
      await expect(runSeaBootstrap(["--version"], {
        appDataRoot,
        rawAsset: rawAssets(runtime, []),
      })).resolves.toBe(86);
    } finally {
      delete (globalThis as Record<string, unknown>)[signal];
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = originalNodePath;
      nodeModule._initPaths();
    }
  });

  it("rejects a tampered declared dependency on warm reuse before its bytes execute", async () => {
    const appDataRoot = await temporaryRoot();
    const dependencyPath = "cli/node_modules/sea-bootstrap-tamper/index.js";
    const markerPath = path.join(appDataRoot, "tampered-dependency-ran");
    const runtime = fixture({
      bootBody: Buffer.from(
        `module.exports = { runBootstrappedCli: async (argv) => argv[0] === "load"\n`
        + `  ? require("sea-bootstrap-tamper").run(${JSON.stringify(markerPath)}) : 0 };\n`,
        "utf8",
      ),
      nodeFiles: [{
        path: dependencyPath,
        content: Buffer.from("module.exports = { run: () => 7 };\n", "utf8"),
      }],
    });
    await expect(runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
    })).resolves.toBe(0);
    await writeFile(
      path.join(appDataRoot, "native", runtime.artifactVersion, "node", ...dependencyPath.split("/")),
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`
      + "module.exports = { run: () => 0 };\n",
      "utf8",
    );
    const warmCalls: string[] = [];

    const failure = await runSeaBootstrap(["load"], {
      appDataRoot,
      rawAsset: rawAssets(runtime, warmCalls, false),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect((failure as RuntimeAssetError).message).toContain("does not match its manifest hash");
    expect(warmCalls).toEqual([MANIFEST_ASSET]);
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let one verified generation import another generation archive", async () => {
    const appDataRoot = await temporaryRoot();
    const markerPath = path.join(appDataRoot, "other-generation-ran");
    const foreignVersion = "sea-bootstrap-foreign-generation";
    const foreignScript = path.join(
      appDataRoot,
      "native",
      foreignVersion,
      HYPERFRAMES_ARCHIVE_TARGET,
      "bin",
      "hyperframes.mjs",
    );
    const foreign = fixture({
      artifactVersion: foreignVersion,
      hyperframesFiles: [{
        path: "bin/hyperframes.mjs",
        content: Buffer.from(
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "ran");\n`,
          "utf8",
        ),
      }],
    });
    await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(foreign, []),
    });
    const candidate = fixture({
      artifactVersion: "sea-bootstrap-current-generation",
      bootBody: Buffer.from(
        `const { pathToFileURL } = require("node:url");\n`
        + `module.exports = { runBootstrappedCli: async () => { await import(pathToFileURL(${JSON.stringify(foreignScript)}).href); return 0; } };\n`,
        "utf8",
      ),
    });

    const failure = await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(candidate, []),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect((failure as RuntimeAssetError).message).toContain("escaped its verified product generation");
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a post-verification swap without executing the replacement bytes", async () => {
    const appDataRoot = await temporaryRoot();
    const markerPath = path.join(appDataRoot, "untrusted-code-ran");
    const runtime = fixture();

    const failure = await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
      afterBootVerified: async (bootPath) => {
        await rm(bootPath);
        await writeFile(
          bootPath,
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`
          + "module.exports = { runBootstrappedCli: async () => 0 };\n",
          "utf8",
        );
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect((failure as RuntimeAssetError).message).toContain("changed after verification");
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects every incomplete or skewed product contract before archive or current mutation", async () => {
    const appDataRoot = await temporaryRoot();
    const currentPath = path.join(appDataRoot, "native", "current.json");
    const good = fixture();
    await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(good, []),
    });
    const priorCurrent = await readFile(currentPath);
    const product = productRuntimeFixtureEntries(MIGRATION_PATHS.map((migrationPath) => ({
      path: migrationPath,
      content: Buffer.from("CREATE TABLE fixture (id INTEGER);\n"),
    })));
    const requiredNodeEntries = [
      SEA_BOOT_RELATIVE_PATH,
      ...product.node.map((file) => file.path),
      ...product.native.map((file) => file.path),
    ];
    const requiredHyperframesEntries = [
      ...product.hyperframes.map((file) => file.path),
      ...product.native.map((file) => file.path),
    ];
    const extraBase = fixture({ artifactVersion: "sea-bootstrap-extra-archive" });
    const extraArchive = archiveFor(
      "unexpected",
      [{ path: "unexpected.txt", content: Buffer.from("unexpected\n", "utf8") }],
      HOST_TAG,
      "unexpected",
    );
    const extraManifest = JSON.parse(
      extraBase.manifestBytes.toString("utf8"),
    ) as EmbeddedRuntimeManifest;
    const extraCandidate: RuntimeFixture = {
      ...extraBase,
      archives: { ...extraBase.archives, unexpected: extraArchive.bytes },
      manifestBytes: Buffer.from(JSON.stringify({
        ...extraManifest,
        archives: [...extraManifest.archives, extraArchive.archive],
      }), "utf8"),
    };
    const invalidCandidates: readonly [string, RuntimeFixture][] = [
      ["missing hyperframes archive", fixture({
        artifactVersion: "sea-bootstrap-node-only",
        includeHyperframes: false,
      })],
      ["unexpected archive", extraCandidate],
      ...requiredNodeEntries.map((entry, index): [string, RuntimeFixture] => [
        `missing node:${entry}`,
        fixture({
          artifactVersion: `sea-bootstrap-missing-node-${index}`,
          omitNodeEntries: [entry],
        }),
      ]),
      ...requiredHyperframesEntries.map((entry, index): [string, RuntimeFixture] => [
        `missing hyperframes:${entry}`,
        fixture({
          artifactVersion: `sea-bootstrap-missing-hyperframes-${index}`,
          omitHyperframesEntries: [entry],
        }),
      ]),
      ["unexpected migration", fixture({
        artifactVersion: "sea-bootstrap-foreign-migration",
        nodeFiles: [{
          path: "drizzle/20990101000000_foreign/migration.sql",
          content: Buffer.from("SELECT 'must-not-run';\n", "utf8"),
        }],
      })],
      ["Node version skew", fixture({
        artifactVersion: "sea-bootstrap-node-version-skew",
        versionOverrides: { node: "0.0.0" },
      })],
      ["HyperFrames version skew", fixture({
        artifactVersion: "sea-bootstrap-hyperframes-version-skew",
        versionOverrides: { hyperframes: "0.0.0" },
      })],
      ["esbuild version skew", fixture({
        artifactVersion: "sea-bootstrap-esbuild-version-skew",
        versionOverrides: { esbuild: "0.0.0" },
      })],
      ["CPython version skew", fixture({
        artifactVersion: "sea-bootstrap-cpython-version-skew",
        versionOverrides: { cpython: "0.0.0" },
      })],
      ["VieNeu version skew", fixture({
        artifactVersion: "sea-bootstrap-vieneu-version-skew",
        versionOverrides: { vieneu: "0.0.0" },
      })],
      ...MOTION_LIBRARIES.map((library, index): [string, RuntimeFixture] => [
        `${library.packageName} version skew`,
        fixture({
          artifactVersion: `sea-bootstrap-motion-version-skew-${index}`,
          versionOverrides: {
            motion: {
              [library.packageName]: "0.0.0",
            } as Partial<EmbeddedRuntimeManifest["versions"]["motion"]>,
          },
        }),
      ]),
    ];
    for (const [label, candidate] of invalidCandidates) {
      const calls: string[] = [];
      const failure = await runSeaBootstrap([], {
        appDataRoot,
        rawAsset: rawAssets(candidate, calls, false),
      }).catch((error: unknown) => error);
      expect(failure, label).toBeInstanceOf(RuntimeAssetError);
      expect((failure as RuntimeAssetError).code, label).toBe(ErrorCode.RuntimeManifestInvalid);
      expect(calls, label).toEqual([MANIFEST_ASSET]);
      expect(
        await isDirectory(path.join(appDataRoot, "native", candidate.artifactVersion)),
        label,
      ).toBe(false);
      expect(await readFile(currentPath), label).toEqual(priorCurrent);
    }
  });

  it("rejects a transitive package that resolves only above the verified node archive", async () => {
    const appDataRoot = await temporaryRoot();
    const packageName = "sea-bootstrap-ancestor-only";
    const markerPath = path.join(appDataRoot, "ancestor-package-ran");
    const bootBody = Buffer.from(
      `const dependency = require("sea-bootstrap-inside-bridge");\n`
      + "module.exports = { runBootstrappedCli: async () => dependency.exitCode };\n",
      "utf8",
    );
    const runtime = fixture({ bootBody, nodeFiles: [{
      path: "cli/node_modules/sea-bootstrap-inside-bridge/index.js",
      content: Buffer.from(`module.exports = require(${JSON.stringify(packageName)});\n`, "utf8"),
    }] });
    const outsidePackage = path.join(
      appDataRoot,
      "native",
      runtime.artifactVersion,
      "node_modules",
      packageName,
    );

    const failure = await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
      afterBootVerified: async () => {
        await mkdir(outsidePackage, { recursive: true });
        await writeFile(
          path.join(outsidePackage, "index.js"),
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`
          + "module.exports = { exitCode: 0 };\n",
          "utf8",
        );
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect((failure as RuntimeAssetError).message).toContain("escaped its verified product generation");
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a direct NODE_PATH fallback outside the verified node archive", async () => {
    const appDataRoot = await temporaryRoot();
    const nodePathRoot = await temporaryRoot("vidcom-sea-bootstrap-node-path-");
    const packageName = "sea-bootstrap-node-path-only";
    const markerPath = path.join(appDataRoot, "node-path-package-ran");
    const packageRoot = path.join(nodePathRoot, packageName);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`
      + "module.exports = { exitCode: 0 };\n",
      "utf8",
    );
    const runtime = fixture({
      bootBody: Buffer.from(
        `const dependency = require(${JSON.stringify(packageName)});\n`
        + "module.exports = { runBootstrappedCli: async () => dependency.exitCode };\n",
        "utf8",
      ),
    });
    const nodeModule = Module as unknown as NodeModuleWithInitPaths;
    const originalNodePath = process.env.NODE_PATH;
    let failure: unknown;
    try {
      process.env.NODE_PATH = nodePathRoot;
      nodeModule._initPaths();
      failure = await runSeaBootstrap([], {
        appDataRoot,
        rawAsset: rawAssets(runtime, []),
      }).catch((error: unknown) => error);
    } finally {
      if (originalNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = originalNodePath;
      nodeModule._initPaths();
    }

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect((failure as RuntimeAssetError).message).toContain("escaped its verified product generation");
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps createRequire anchors inside the active verified generation", async () => {
    const appDataRoot = await temporaryRoot();
    const packageName = "sea-bootstrap-create-require-escape";
    const markerPath = path.join(appDataRoot, "create-require-package-ran");
    const runtime = fixture({
      bootBody: Buffer.from(
        `const path = require("node:path");\nconst { createRequire } = require("node:module");\n`
        + `const escapedRequire = createRequire(path.resolve(__dirname, "../../escape.cjs"));\n`
        + `module.exports = { runBootstrappedCli: async () => escapedRequire(${JSON.stringify(packageName)}).exitCode };\n`,
        "utf8",
      ),
    });
    const outsidePackage = path.join(
      appDataRoot,
      "native",
      runtime.artifactVersion,
      "node_modules",
      packageName,
    );

    const failure = await runSeaBootstrap([], {
      appDataRoot,
      rawAsset: rawAssets(runtime, []),
      afterBootVerified: async () => {
        await mkdir(outsidePackage, { recursive: true });
        await writeFile(
          path.join(outsidePackage, "index.js"),
          `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`
          + "module.exports = { exitCode: 0 };\n",
          "utf8",
        );
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect((failure as RuntimeAssetError).message).toContain("escaped its verified product generation");
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
