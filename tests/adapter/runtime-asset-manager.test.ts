import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AtomicDirectoryLock,
  parseRuntimeCurrentPointer,
  readPublishedRuntimeInstallation,
  RUNTIME_MANIFEST_FILENAME,
  RuntimeAssetError,
  RuntimeAssetManager,
  probeCurrentProcessIdentity,
  probeProcessIdentity,
  windowsProbeEnvironment,
  type EmbeddedRuntimeManifest,
  type RuntimeAssetManagerHooks,
  type RuntimeAssetManagerPhase,
  type RuntimeAssetSource,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveFor,
  assetSource,
  HOST_SUPPORTED,
  runtimeManifest,
} from "../support/runtime-fixture";

const MAX_STATE_BYTES = 1024 * 1024;
const ARCHIVE_KEY = "node";
const ENTRY_PATH = "runtime.txt";
const SCRIPT_PATH = "bin/run.sh";
const SCRIPT_MODE = 0o755;
const PYTHON_PACKAGE_COUNT = 48_000;
const LOCK_FILENAME = "runtime-bootstrap.lock";
const FIXTURE_BODY = Buffer.from("vidcom runtime fixture\n", "utf8");
const SCRIPT_BODY = Buffer.from("#!/bin/sh\nexit 0\n", "utf8");
const POSIX = process.platform !== "win32";

const roots: string[] = [];
const children: ChildProcess[] = [];

/** Kills a child and waits a bounded time; a survivor must not hold the suite open. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise<void>((resolve) => {
    setTimeout(resolve, 5_000).unref();
  })]);
  child.unref();
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix = "vidcom-runtime-"): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function fixture(artifactVersion: string): {
  manifest: EmbeddedRuntimeManifest;
  source: RuntimeAssetSource;
} {
  const { bytes, archive } = archiveFor(ARCHIVE_KEY, [
    { path: ENTRY_PATH, content: FIXTURE_BODY },
    { path: SCRIPT_PATH, content: SCRIPT_BODY, mode: SCRIPT_MODE },
  ]);
  const manifest = runtimeManifest(artifactVersion, [archive], PYTHON_PACKAGE_COUNT);
  return { manifest, source: assetSource(manifest, { [ARCHIVE_KEY]: bytes }) };
}

function manager(
  appDataRoot: string,
  source: RuntimeAssetSource,
  options: { hooks?: RuntimeAssetManagerHooks; lockTimeoutMs?: number } = {},
): RuntimeAssetManager {
  return new RuntimeAssetManager({
    appDataRoot,
    source,
    hooks: options.hooks,
    lock: options.lockTimeoutMs === undefined ? undefined : new AtomicDirectoryLock(
      path.join(appDataRoot, LOCK_FILENAME),
      { timeoutMs: options.lockTimeoutMs, pollIntervalMs: 50 },
    ),
  });
}

function markerPath(manifest: EmbeddedRuntimeManifest, versionRoot: string): string {
  const sha256 = manifest.archives[0]?.sha256 ?? "";
  return path.join(versionRoot, ARCHIVE_KEY, `.ready-${sha256.slice("sha256:".length)}`);
}

async function mode(pathname: string): Promise<number> {
  return (await stat(pathname)).mode & 0o777;
}

describe.skipIf(!HOST_SUPPORTED)("runtime installed-manifest byte bound", () => {
  it("stays ready when the published projection is larger than the state bound", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    const installed = await manager(appDataRoot, source).ensureAll();

    const manifestPath = path.join(installed.versionRoot, RUNTIME_MANIFEST_FILENAME);
    const metadata = await stat(manifestPath);
    expect(metadata.size).toBeGreaterThan(MAX_STATE_BYTES);

    const inspection = await manager(appDataRoot, source).inspect();
    expect(inspection.state).toBe("ready");
    expect(inspection.current).toBe(true);
  });

  it("reuses the installation instead of re-extracting on the second ensureAll", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    await manager(appDataRoot, source).ensureAll();

    const second = await manager(appDataRoot, source).ensureAll();
    expect(second.extracted).toEqual([]);
    expect(second.reused).toEqual([ARCHIVE_KEY]);
  });

  it("prunes an old version whose persisted manifest is larger than the state bound", async () => {
    const appDataRoot = await temporaryRoot();
    await manager(appDataRoot, fixture("1.0.0").source).ensureAll();
    await manager(appDataRoot, fixture("2.0.0").source).ensureAll();

    const oldManifest = path.join(appDataRoot, "native", "1.0.0", RUNTIME_MANIFEST_FILENAME);
    expect((await stat(oldManifest)).size).toBeGreaterThan(MAX_STATE_BYTES);

    const result = await manager(appDataRoot, fixture("2.0.0").source).pruneOldVersions({
      gracePeriodMs: 0,
      startupSucceededAt: new Date(0),
      isVersionInUse: () => false,
    });
    expect(result.deferred).toBe(false);
    expect(result.pruned).toEqual(["1.0.0"]);
    expect(result.retained).toEqual(["2.0.0"]);
  });

  it("leaves a foreign version directory untouched", async () => {
    const appDataRoot = await temporaryRoot();
    await manager(appDataRoot, fixture("2.0.0").source).ensureAll();

    const foreign = path.join(appDataRoot, "native", "0.9.0");
    await mkdir(foreign, { recursive: true, mode: 0o700 });
    await writeFile(path.join(foreign, RUNTIME_MANIFEST_FILENAME), `{"id":"${randomUUID()}"}\n`, "utf8");

    const result = await manager(appDataRoot, fixture("2.0.0").source).pruneOldVersions({
      gracePeriodMs: 0,
      startupSucceededAt: new Date(0),
      isVersionInUse: () => false,
    });
    expect(result.pruned).toEqual([]);
    expect((await stat(foreign)).isDirectory()).toBe(true);
  });
});

describe.skipIf(!HOST_SUPPORTED)("runtime repair and recovery", () => {
  it.each([
    "bad\0version",
    "a".repeat(5_000),
    "../escape",
    "CON",
    "current.json",
  ])("treats an invalid persisted current version as recoverable: %j", async (artifactVersion) => {
    const pointer = {
      schemaVersion: 1,
      artifactVersion,
      platform: "linux-x64",
      manifest: `${artifactVersion}/${RUNTIME_MANIFEST_FILENAME}`,
    };
    expect(parseRuntimeCurrentPointer(pointer)).toBeUndefined();

    const appDataRoot = await temporaryRoot();
    await mkdir(path.join(appDataRoot, "native"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(appDataRoot, "native", "current.json"),
      `${JSON.stringify(pointer)}\n`,
      "utf8",
    );
    await expect(readPublishedRuntimeInstallation(appDataRoot, "linux", "x64"))
      .resolves.toBeNull();
  });

  it("rejects archive targets that would publish over one another", async () => {
    const appDataRoot = await temporaryRoot();
    const first = archiveFor("node", [{ path: "node.txt", content: FIXTURE_BODY }], undefined, "runtime");
    const second = archiveFor("ffmpeg", [{ path: "ffmpeg.txt", content: FIXTURE_BODY }], undefined, "runtime-other");
    const third = archiveFor("hyperframes", [{ path: "hf.txt", content: FIXTURE_BODY }], undefined, "runtime/child");
    const manifest = runtimeManifest("1.0.0", [first.archive, second.archive, third.archive]);

    const failure = await manager(appDataRoot, assetSource(manifest, {
      node: first.bytes,
      ffmpeg: second.bytes,
      hyperframes: third.bytes,
    })).ensureAll().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect(await readdir(appDataRoot)).toEqual([]);
  });

  it("publishes and later resolves the manifest target rather than guessing from the archive key", async () => {
    const appDataRoot = await temporaryRoot();
    const { bytes, archive } = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: FIXTURE_BODY }],
      undefined,
      "toolchain/native",
    );
    const manifest = runtimeManifest("1.0.0", [archive]);
    const source = assetSource(manifest, { [ARCHIVE_KEY]: bytes });

    const installed = await manager(appDataRoot, source).ensureAll();
    const expected = path.join(installed.versionRoot, "toolchain", "native");
    expect(installed.archiveRoots[ARCHIVE_KEY]).toBe(expected);
    expect(await readFile(path.join(expected, ENTRY_PATH))).toEqual(FIXTURE_BODY);

    const published = await readPublishedRuntimeInstallation(appDataRoot);
    expect(published?.versionRoot).toBe(installed.versionRoot);
    expect(published?.archiveRoots[ARCHIVE_KEY]).toBe(expected);
    expect((await manager(appDataRoot, source).inspect()).state).toBe("ready");
  });

  it("reports broken and re-extracts a tampered payload", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    const installed = await manager(appDataRoot, source).ensureAll();
    const payload = path.join(installed.versionRoot, ARCHIVE_KEY, ENTRY_PATH);
    await writeFile(payload, "tampered\n", "utf8");

    // A tampered payload keeps its marker, so `inspect` alone cannot see it.
    const repaired = await manager(appDataRoot, source).repair();
    expect(repaired.extracted).toEqual([ARCHIVE_KEY]);
    expect(await readFile(payload)).toEqual(FIXTURE_BODY);
    expect((await manager(appDataRoot, source).inspect()).state).toBe("ready");
  });

  it("reports broken when a ready marker is removed and heals on ensureAll", async () => {
    const appDataRoot = await temporaryRoot();
    const { manifest, source } = fixture("1.0.0");
    const installed = await manager(appDataRoot, source).ensureAll();
    await unlink(markerPath(manifest, installed.versionRoot));

    const broken = await manager(appDataRoot, source).inspect();
    expect(broken.state).toBe("broken");
    expect(broken.archives[0]?.reason).toBe("marker_missing");
    expect(await readPublishedRuntimeInstallation(appDataRoot)).toBeNull();

    const healed = await manager(appDataRoot, source).ensureAll();
    expect(healed.extracted).toEqual([ARCHIVE_KEY]);
    expect((await manager(appDataRoot, source).inspect()).state).toBe("ready");
  });

  it("does not publish a root whose ready marker has the wrong identity", async () => {
    const appDataRoot = await temporaryRoot();
    const { manifest, source } = fixture("1.0.0");
    const installed = await manager(appDataRoot, source).ensureAll();
    const marker = markerPath(manifest, installed.versionRoot);
    const value = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
    await writeFile(marker, `${JSON.stringify({ ...value, archiveKey: "not-node" }, null, 2)}\n`, "utf8");

    expect((await manager(appDataRoot, source).inspect()).archives[0]?.reason).toBe("marker_invalid");
    expect(await readPublishedRuntimeInstallation(appDataRoot)).toBeNull();
  });

  it("requires the installed manifest's exact canonical bytes", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    const installed = await manager(appDataRoot, source).ensureAll();
    const manifestPath = path.join(installed.versionRoot, RUNTIME_MANIFEST_FILENAME);
    const value = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify(value), "utf8");

    expect(await readPublishedRuntimeInstallation(appDataRoot)).toBeNull();
    expect((await manager(appDataRoot, source).inspect()).state).toBe("broken");
  });

  it("rejects a repair for an archive outside the host manifest", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    await manager(appDataRoot, source).ensureAll();

    const failure = await manager(appDataRoot, source)
      .repair({ keys: ["ffmpeg"] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeManifestInvalid);
  });

  it("rebuilds after the whole native tree is deleted by hand", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    await manager(appDataRoot, source).ensureAll();
    await rm(path.join(appDataRoot, "native"), { recursive: true, force: true });

    expect((await manager(appDataRoot, source).inspect()).state).toBe("missing");
    const rebuilt = await manager(appDataRoot, source).ensureAll();
    expect(rebuilt.extracted).toEqual([ARCHIVE_KEY]);
    expect((await manager(appDataRoot, source).inspect()).state).toBe("ready");
  });
});

const CRASH_PHASES: readonly RuntimeAssetManagerPhase[] = [
  "afterExtract",
  "afterValidate",
  "afterRename",
  "beforeMarkerCommit",
];
const PROCESS_CRASH_PHASES: readonly RuntimeAssetManagerPhase[] = [
  ...CRASH_PHASES,
  "afterMarker",
];

describe.skipIf(!HOST_SUPPORTED)("runtime crash recovery per publication phase", () => {
  it.each(PROCESS_CRASH_PHASES)(
    "recovers nested-target residue after the publishing child is killed at %s",
    async (crashPhase) => {
    const appDataRoot = await temporaryRoot();
    const target = "layers/toolchain/native";
    const current = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: FIXTURE_BODY }],
      undefined,
      target,
    );
    const currentManifest = runtimeManifest("1.0.0", [current.archive]);
    await manager(
      appDataRoot,
      assetSource(currentManifest, { [ARCHIVE_KEY]: current.bytes }),
    ).ensureAll();

    const replacementBody = Buffer.from("replacement after process kill\n", "utf8");
    const replacement = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: replacementBody }],
      undefined,
      target,
    );
    const replacementManifest = runtimeManifest("1.0.0", [replacement.archive]);
    const inputPath = path.join(appDataRoot, "crash-child-input.json");
    await writeFile(inputPath, JSON.stringify({
      appDataRoot,
      manifest: replacementManifest,
      archive: replacement.bytes.toString("base64"),
    }), "utf8");
    const moduleUrl = pathToFileURL(
      path.resolve("packages/adapter/src/runtime/runtime-asset-manager.ts"),
    ).href;
    const tsxApiUrl = pathToFileURL(
      createRequire(path.resolve("packages/cli/package.json")).resolve("tsx/esm/api"),
    ).href;
    const program = `
      import { register } from ${JSON.stringify(tsxApiUrl)};
      import { readFile } from "node:fs/promises";
      register();
      const { RuntimeAssetManager } = await import(${JSON.stringify(moduleUrl)});
      const input = JSON.parse(await readFile(${JSON.stringify(inputPath)}, "utf8"));
      const source = {
        readManifest: () => input.manifest,
        readArchive: () => Buffer.from(input.archive, "base64"),
      };
      await new RuntimeAssetManager({
        appDataRoot: input.appDataRoot,
        source,
        hooks: { onPhase: async (phase) => {
          if (phase === ${JSON.stringify(crashPhase)}) {
            process.stdout.write("READY\\n");
            await new Promise(() => {});
          }
        } },
      }).repair();
    `;
    const environment = { ...process.env };
    delete environment.ESBUILD_BINARY_PATH;
    delete environment.ESBUILD_WORKER_THREADS;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: path.resolve("."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error(`crash child did not publish: ${stderr}`)), 30_000);
      timeout.unref();
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("READY\n")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (!stdout.includes("READY\n")) {
          clearTimeout(timeout);
          reject(new Error(`crash child exited ${String(code ?? signal)}: ${stderr}`));
        }
      });
    });

    const closed = new Promise<void>((resolve) => child.once("close", () => { resolve(); }));
    child.kill("SIGKILL");
    await closed;
    const versionRoot = path.join(appDataRoot, "native", "1.0.0");
    const residue = await readdir(versionRoot);
    expect(residue.some((entry) => entry.endsWith(".tmp")))
      .toBe(crashPhase === "afterExtract" || crashPhase === "afterValidate");
    expect(residue.some((entry) => entry.endsWith(".quarantine")))
      .toBe(crashPhase === "afterRename"
        || crashPhase === "beforeMarkerCommit"
        || crashPhase === "afterMarker");
    const replacementMarker = path.join(
      versionRoot,
      target,
      `.ready-${replacement.archive.sha256.slice("sha256:".length)}`,
    );
    expect(await lstat(replacementMarker).then(() => true, () => false))
      .toBe(crashPhase === "afterMarker");

    const replacementSource = assetSource(replacementManifest, { [ARCHIVE_KEY]: replacement.bytes });
    const recovered = await manager(appDataRoot, replacementSource, { lockTimeoutMs: 30_000 }).ensureAll();
    expect(recovered.extracted).toEqual(crashPhase === "afterMarker" ? [] : [ARCHIVE_KEY]);
    expect(recovered.reused).toEqual(crashPhase === "afterMarker" ? [ARCHIVE_KEY] : []);
    expect(await readFile(path.join(recovered.archiveRoots[ARCHIVE_KEY]!, ENTRY_PATH)))
      .toEqual(replacementBody);
    expect((await readdir(versionRoot)).some((entry) => entry.endsWith(".quarantine"))).toBe(false);
    expect((await readdir(versionRoot)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
    expect((await manager(appDataRoot, replacementSource).inspect()).state).toBe("ready");
    },
    60_000,
  );

  it("restores a quarantined nested target when publication crashes after rename", async () => {
    const appDataRoot = await temporaryRoot();
    const target = "toolchain/native";
    const current = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: FIXTURE_BODY }],
      undefined,
      target,
    );
    const currentManifest = runtimeManifest("1.0.0", [current.archive]);
    const currentSource = assetSource(currentManifest, { [ARCHIVE_KEY]: current.bytes });
    const installed = await manager(appDataRoot, currentSource).ensureAll();
    const payload = path.join(installed.archiveRoots[ARCHIVE_KEY]!, ENTRY_PATH);

    const replacementBody = Buffer.from("replacement runtime fixture\n", "utf8");
    const replacement = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: replacementBody }],
      undefined,
      target,
    );
    const replacementManifest = runtimeManifest("1.0.0", [replacement.archive]);
    const replacementSource = assetSource(replacementManifest, { [ARCHIVE_KEY]: replacement.bytes });
    const failure = await manager(appDataRoot, replacementSource, {
      hooks: {
        onPhase: async (phase) => {
          if (phase === "afterRename") throw new Error("simulated crash after nested target rename");
        },
      },
    }).repair().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).details?.cause)
      .toBe("simulated crash after nested target rename");

    expect(await readFile(payload)).toEqual(FIXTURE_BODY);
    expect((await manager(appDataRoot, currentSource).inspect()).state).toBe("ready");

    const repaired = await manager(appDataRoot, replacementSource).repair();
    expect(repaired.archiveRoots[ARCHIVE_KEY]).toBe(path.join(repaired.versionRoot, target));
    expect(await readFile(payload)).toEqual(replacementBody);
  });

  it.each(CRASH_PHASES)("recovers after a crash at %s", async (phase) => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    const hooks: RuntimeAssetManagerHooks = {
      onPhase: async (current) => {
        if (current === phase) throw new Error(`simulated crash at ${phase}`);
      },
    };

    await expect(manager(appDataRoot, source, { hooks }).ensureAll()).rejects.toThrow();
    expect((await manager(appDataRoot, source).inspect()).state).not.toBe("ready");

    const recovered = await manager(appDataRoot, source).ensureAll();
    expect(recovered.extracted).toEqual([ARCHIVE_KEY]);
    const healthy = await manager(appDataRoot, source).inspect();
    expect(healthy.state).toBe("ready");
    expect(healthy.current).toBe(true);
  });

  it("reuses the payload after a crash at afterMarker and only republishes metadata", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    const hooks: RuntimeAssetManagerHooks = {
      onPhase: async (current) => {
        if (current === "afterMarker") throw new Error("simulated crash at afterMarker");
      },
    };

    await expect(manager(appDataRoot, source, { hooks }).ensureAll()).rejects.toThrow();
    // The marker is already committed, so only `current.json` is still missing.
    const crashed = await manager(appDataRoot, source).inspect();
    expect(crashed.state).toBe("broken");
    expect(crashed.current).toBe(false);
    expect(crashed.archives[0]?.state).toBe("ready");

    const recovered = await manager(appDataRoot, source).ensureAll();
    expect(recovered.extracted).toEqual([]);
    expect(recovered.reused).toEqual([ARCHIVE_KEY]);
    expect((await manager(appDataRoot, source).inspect()).state).toBe("ready");
  });
});

describe.skipIf(!HOST_SUPPORTED)("runtime app-data confinement", () => {
  it.skipIf(!POSIX)("fails closed after an intermediate nested-target directory becomes a symlink", async () => {
    const appDataRoot = await temporaryRoot();
    const outside = await temporaryRoot("vidcom-runtime-published-outside-");
    const target = "layers/toolchain/native";
    const { bytes, archive } = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: FIXTURE_BODY }],
      undefined,
      target,
    );
    const manifest = runtimeManifest("1.0.0", [archive]);
    const source = assetSource(manifest, { [ARCHIVE_KEY]: bytes });
    const installed = await manager(appDataRoot, source).ensureAll();
    const layers = path.join(installed.versionRoot, "layers");
    const escapedLayers = path.join(outside, "layers");
    await rename(layers, escapedLayers);
    await symlink(escapedLayers, layers);

    const inspection = await manager(appDataRoot, source).inspect();
    expect(inspection.state).toBe("broken");
    expect(inspection.archives[0]?.reason).toBe("target_not_directory");
    expect(await readPublishedRuntimeInstallation(appDataRoot)).toBeNull();
    const failure = await manager(appDataRoot, source).ensureAll().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect(await readFile(path.join(escapedLayers, "toolchain", "native", ENTRY_PATH)))
      .toEqual(FIXTURE_BODY);
  });

  it("classifies a corrupt intermediate target parent as incomplete", async () => {
    const appDataRoot = await temporaryRoot();
    const target = "layers/toolchain/native";
    const { bytes, archive } = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: FIXTURE_BODY }],
      undefined,
      target,
    );
    const manifest = runtimeManifest("1.0.0", [archive]);
    const source = assetSource(manifest, { [ARCHIVE_KEY]: bytes });
    const installed = await manager(appDataRoot, source).ensureAll();
    const layers = path.join(installed.versionRoot, "layers");
    await rm(layers, { recursive: true });
    await writeFile(layers, "not a directory\n", "utf8");

    const inspection = await manager(appDataRoot, source).inspect();
    expect(inspection.state).toBe("broken");
    expect(inspection.archives[0]?.reason).toBe("target_not_directory");
    expect(await readPublishedRuntimeInstallation(appDataRoot)).toBeNull();
    await expect(manager(appDataRoot, source).ensureAll()).rejects.toBeInstanceOf(RuntimeAssetError);
  });

  it.skipIf(!POSIX)("rejects a symlinked parent for a nested archive target", async () => {
    const appDataRoot = await temporaryRoot();
    const outside = await temporaryRoot("vidcom-runtime-outside-");
    const target = "toolchain/native";
    const { bytes, archive } = archiveFor(
      ARCHIVE_KEY,
      [{ path: ENTRY_PATH, content: FIXTURE_BODY }],
      undefined,
      target,
    );
    const manifest = runtimeManifest("1.0.0", [archive]);
    const source = assetSource(manifest, { [ARCHIVE_KEY]: bytes });
    const failure = await manager(appDataRoot, source, {
      hooks: {
        onPhase: async (phase) => {
          if (phase !== "afterValidate") return;
          await symlink(outside, path.join(appDataRoot, "native", "1.0.0", "toolchain"));
        },
      },
    }).ensureAll().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.RuntimeExtractionIncomplete);
    expect((failure as RuntimeAssetError).message).toContain("target parent is not a real directory");
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(!POSIX)("keeps every owned directory at 0700 and restores manifest modes", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");
    const installed = await manager(appDataRoot, source).ensureAll();
    const archiveRoot = installed.archiveRoots[ARCHIVE_KEY] ?? "";

    expect(await mode(appDataRoot)).toBe(0o700);
    expect(await mode(path.join(appDataRoot, "native"))).toBe(0o700);
    expect(await mode(installed.versionRoot)).toBe(0o700);
    expect(await mode(archiveRoot)).toBe(0o700);
    expect(await mode(path.join(archiveRoot, path.dirname(SCRIPT_PATH)))).toBe(0o700);
    expect(await mode(path.join(archiveRoot, ENTRY_PATH))).toBe(0o644);
    expect(await mode(path.join(archiveRoot, SCRIPT_PATH))).toBe(SCRIPT_MODE);
  });

  it("writes nothing into the workspace or next to the artifact", async () => {
    const appDataRoot = await temporaryRoot();
    const workspace = await temporaryRoot("vidcom-workspace-");
    const artifactDirectory = await temporaryRoot("vidcom-artifact-");
    await writeFile(path.join(artifactDirectory, "vidcom"), "binary\n", "utf8");

    const before = await Promise.all([workspace, artifactDirectory].map((root) => readdir(root)));
    await manager(appDataRoot, fixture("1.0.0").source).ensureAll();
    const after = await Promise.all([workspace, artifactDirectory].map((root) => readdir(root)));

    expect(after).toEqual(before);
    expect(after[0]).toEqual([]);
    expect(after[1]).toEqual(["vidcom"]);
  });
});

describe("windows identity probe environment", () => {
  // Measured on CI: a PSModulePath naming the stock module directory made
  // Get-Process and Get-CimInstance hang past 20s, while an empty one answered
  // in ~320ms. Deleting the variable is not equivalent — PowerShell computes
  // its own default and hangs again. Only Windows CI can catch a regression
  // here, so the invariant is pinned on every platform instead.
  it("disables module discovery rather than naming a module directory", () => {
    const environment = windowsProbeEnvironment(
      "C:\\Windows",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(environment.PSModulePath).toBe("");
    expect(Object.hasOwn(environment, "PSModulePath")).toBe(true);
  });

  it("forwards the variables PowerShell needs to start", () => {
    const environment = windowsProbeEnvironment(
      "C:\\Windows",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(environment.SystemRoot).toBe("C:\\Windows");
    expect(environment.PATH).toContain("System32");
  });
});

describe("runtime bootstrap lock identity", () => {
  it("probes its own identity once and reuses the exhaustive answer", async () => {
    const first = await probeCurrentProcessIdentity();
    expect(first.exhaustive).toBe(true);
    expect(first.identity?.pid).toBe(process.pid);

    // A live process cannot change its own PID or start time, so the cached
    // answer must be the identical object rather than a fresh OS probe.
    const started = Date.now();
    const second = await probeCurrentProcessIdentity();
    expect(second).toBe(first);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("never reclaims a live owner recorded under an older identity scheme", async () => {
    const appDataRoot = await temporaryRoot();
    const lockPath = path.join(appDataRoot, LOCK_FILENAME);
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    // This process is alive, but its identity is stamped with a scheme this
    // build no longer produces. Comparing across schemes would read as a
    // mismatch and hand the lock to someone else while the owner still runs.
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      pid: process.pid,
      processStartIdentity: "legacy-scheme:2020-01-01T00:00:00.0000000Z",
      nonce: randomBytes(32).toString("base64url"),
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");

    const lock = new AtomicDirectoryLock(lockPath, { timeoutMs: 600, pollIntervalMs: 50 });
    const failure = await lock.acquire().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.BootstrapLockTimeout);
    // The owner record must survive: waiting is correct, stealing is not.
    expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")))
      .toMatchObject({ processStartIdentity: "legacy-scheme:2020-01-01T00:00:00.0000000Z" });
  });

  // Only the Windows probe honours the disable switch, and the identity cache is
  // module-scoped, so a blind probe needs both a fresh module graph and win32.
  it.skipIf(POSIX)("fails fast with an identity error, not a timeout, when the probe is blind", async () => {
    const appDataRoot = await temporaryRoot();
    const previous = process.env.VIDCOM_DISABLE_ENUMERATORS;
    process.env.VIDCOM_DISABLE_ENUMERATORS = "powershell-cim";
    vi.resetModules();
    try {
      const fresh = await import("@vidcom/adapter");
      const lock = new fresh.AtomicDirectoryLock(path.join(appDataRoot, LOCK_FILENAME), {
        timeoutMs: 30_000,
        pollIntervalMs: 50,
      });
      const started = Date.now();
      const failure = await lock.acquire().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("probe its own OS identity");
      // The old code spent the whole lock budget and then blamed contention.
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      if (previous === undefined) delete process.env.VIDCOM_DISABLE_ENUMERATORS;
      else process.env.VIDCOM_DISABLE_ENUMERATORS = previous;
      vi.resetModules();
    }
  });
});

describe.skipIf(!HOST_SUPPORTED)("runtime concurrent cold start", () => {
  it("extracts exactly once across four concurrent cold starts", async () => {
    const appDataRoot = await temporaryRoot();
    let prepared = 0;
    // Separate instances, separate locks: exclusion has to come from the
    // filesystem. The wait budget is generous because the losers are waiting on
    // a real extraction, and Windows pays an ACL subprocess per directory.
    const managers = Array.from({ length: 4 }, () => new RuntimeAssetManager({
      appDataRoot,
      source: fixture("1.0.0").source,
      observer: { preparing: () => { prepared += 1; } },
      lock: new AtomicDirectoryLock(path.join(appDataRoot, LOCK_FILENAME), {
        timeoutMs: 60_000,
        pollIntervalMs: 50,
      }),
    }));

    const results = await Promise.all(managers.map((instance) => instance.ensureAll()));
    expect(prepared).toBe(1);
    expect(results.filter((result) => result.extracted.length > 0)).toHaveLength(1);
    expect(new Set(results.map((result) => result.versionRoot)).size).toBe(1);
    expect((await manager(appDataRoot, fixture("1.0.0").source).inspect()).state).toBe("ready");
  });

  it("waits instead of overwriting while another live process holds the lock", async () => {
    const appDataRoot = await temporaryRoot();
    const { source } = fixture("1.0.0");

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    children.push(child);
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const probe = await probeProcessIdentity(pid);
    expect(probe.exhaustive).toBe(true);

    const lockPath = path.join(appDataRoot, LOCK_FILENAME);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      pid,
      processStartIdentity: probe.identity?.startedAt,
      nonce: randomBytes(32).toString("base64url"),
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");

    const failure = await manager(appDataRoot, source, { lockTimeoutMs: 600 })
      .ensureAll()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeAssetError);
    expect((failure as RuntimeAssetError).code).toBe(ErrorCode.BootstrapLockTimeout);
    expect((await manager(appDataRoot, source).inspect()).state).not.toBe("ready");

    await stopChild(child);

    const installed = await manager(appDataRoot, source, { lockTimeoutMs: 30_000 }).ensureAll();
    expect(installed.extracted).toEqual([ARCHIVE_KEY]);
    expect((await manager(appDataRoot, source).inspect()).state).toBe("ready");
  });
});
