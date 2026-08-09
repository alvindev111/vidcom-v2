import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  AppSettingsStore,
  CompilerGuard,
  DOWNLOAD_CACHE_COMPONENTS,
  DownloadCacheCoordinator,
  ESBUILD_BINARY_PATH,
  ESBUILD_WORKER_THREADS,
  inspectPublishedRuntimeIntegrity,
  NodeProcessRunner,
  NodeProcessSupervisor,
  VieNeuTtsProvider,
  allowlistedEnvironment,
  defaultVieNeuCommand,
  openVidcomDatabase,
  readVidcomSettings,
  readPublishedRuntimeInstallation,
  resolveChrome,
  resolveRuntimePaths,
  RUNTIME_CURRENT_FILENAME,
  RUNTIME_MANIFEST_FILENAME,
  type RuntimePaths,
} from "@vidcom/adapter";

import { defaultAppDataRoot } from "../next-host";
import { compilerProbeCommand, runCompilerProbeProcess } from "../compiler-probe";
import type { DoctorContext, DoctorHistory, DoctorProbes, ProbeResult } from "./doctor-checks";

const PROBE_TIMEOUT_MS = 10_000;

function present(target: string): ProbeResult {
  return existsSync(target)
    ? { ok: true }
    : { ok: false, absent: true, detail: `${target} is not there` };
}

/**
 * Runs a binary and believes only what it prints.
 *
 * Presence is not health: a truncated download still exists, and every check
 * here that merely looked would pass on exactly the install that fails later
 * with an unrelated error.
 */
function runs(executable: string, args: readonly string[], caBundlePath?: string): ProbeResult {
  if (!existsSync(executable)) return { ok: false, absent: true, detail: `${executable} is not there` };
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    shell: false,
    // The same environment every other child gets. Probing with the parent's
    // environment would test a configuration the product never runs — and
    // `runtime.python-utf8` in particular exists to catch an encoding that only
    // goes wrong because of what is, or is not, in this environment.
    env: allowlistedEnvironment(
      process.env,
      {},
      caBundlePath ? { caBundlePath } : {},
    ),
  });
  if (result.error) return { ok: false, detail: `${executable} could not run: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, detail: `${executable} exited ${String(result.status)}` };
  const version = `${result.stdout}`.trim().split("\n", 1)[0] ?? "";
  return { ok: true, detail: version, version };
}

function loopbackBindable(): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve({ ok: false, detail: error.message }));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve({ ok: true }));
    });
  });
}

export interface ClosableDoctorContext extends DoctorContext {
  /**
   * Releases the database handle this context opened.
   *
   * Windows holds the file until the handle is gone, so a caller that only
   * exits gets away with leaking it while a caller that tries to delete the
   * directory afterwards gets EBUSY. Closing is the honest end of "this
   * command opened a database".
   */
  close(): Promise<void>;
}

export interface DoctorContextOptions {
  deep: boolean;
  appDataRoot?: string;
  /** Prepared paths win; omitted callers inspect the version selected by current.json. */
  runtimePaths?: RuntimePaths;
  versionRoot?: string;
}

function seaProcess(): boolean {
  const api = process.getBuiltinModule?.("node:sea") as { isSea?(): boolean } | undefined;
  return api?.isSea?.() === true;
}

function errorCode(error: unknown): string | null {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

/**
 * Wires the checks to the machine they are asked about.
 *
 * Anything that lives in the runtime archive answers "not there" on a source
 * checkout, which is the truth: the archive is what a packaged build extracts,
 * and pretending otherwise would make `doctor` green on an install that cannot
 * render.
 */
export async function createDoctorContext(
  options: DoctorContextOptions,
): Promise<ClosableDoctorContext> {
  const settings = await readVidcomSettings().catch(() => null);
  const appDataRoot = options.appDataRoot ?? defaultAppDataRoot(settings ?? undefined);
  let publicationFailure: ProbeResult | null = null;
  const published = await readPublishedRuntimeInstallation(path.resolve(appDataRoot)).catch((error: unknown) => {
    const code = errorCode(error);
    publicationFailure = {
      ok: false,
      detail: code === "EACCES" || code === "EPERM"
        ? `current runtime metadata is not readable (${code}); restore app-data read permissions`
        : `current runtime metadata could not be inspected${code === null ? "" : ` (${code})`}`,
      remedy: "restore access to app-data, then rerun `vidcom doctor --deep`; repair only after it is readable",
    };
    return null;
  });
  // An injected path normally wins, but not after the current publication could
  // not be read: continuing would execute an unverified tree while doctor is
  // explicitly reporting that its authority is unavailable.
  const runtimePaths = publicationFailure !== null
    ? null
    : options.runtimePaths
      ?? (published
        ? resolveRuntimePaths({
            mode: "artifact",
            appDataRoot,
            versionRoot: published.versionRoot,
            archiveRoots: published.archiveRoots,
          })
        : seaProcess() ? null : resolveRuntimePaths({ mode: "development", appDataRoot }));
  const versionRoot = publicationFailure !== null
    ? null
    : options.versionRoot ?? published?.versionRoot ?? null;
  const database = openVidcomDatabase(appDataRoot);
  const downloads = new DownloadCacheCoordinator({ cacheRoot: path.resolve(appDataRoot) });
  const appSettings = new AppSettingsStore(database);
  const executable = (root: string, ...segments: string[]): string =>
    path.join(root, ...segments) + (process.platform === "win32" ? ".exe" : "");
  const caBundlePath = settings?.runtime?.caBundlePath ?? undefined;
  const esbuildPath = runtimePaths
    ? executable(runtimePaths.nativeDependenciesRoot, "bin", "esbuild")
    : null;
  const compilerGuard = esbuildPath
    ? new CompilerGuard({
        esbuildBinaryPath: esbuildPath,
        probeRunner: (timeoutMs) => runCompilerProbeProcess({
          supervisor: new NodeProcessSupervisor(undefined, caBundlePath ? { caBundlePath } : {}),
          command: compilerProbeCommand(),
          environment: {
            [ESBUILD_BINARY_PATH]: esbuildPath,
            [ESBUILD_WORKER_THREADS]: "0",
            VIDCOM_APP_DATA: appDataRoot,
          },
          timeoutMs,
        }),
      })
    : null;
  const vieneuProbe = runtimePaths
    ? new VieNeuTtsProvider({
        processes: new NodeProcessRunner(PROBE_TIMEOUT_MS, caBundlePath),
        command: () => settings?.tts.vieneu.command
          ?? defaultVieNeuCommand(runtimePaths.nativeDependenciesRoot, runtimePaths.mode === "artifact"),
        modelCacheRoot: downloads.componentRoot(DOWNLOAD_CACHE_COMPONENTS.models),
        downloadCache: downloads,
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        caBundlePath,
        offline: true,
        modelRevision: settings?.tts.vieneu.modelRevision,
      })
    : null;
  const unavailableRuntime = (label: string): ProbeResult => ({
    ok: false,
    absent: true,
    detail: `${label} is unavailable because no verified current runtime is published`,
  });
  const manifestProbe = (): ProbeResult => {
    if (publicationFailure !== null) return publicationFailure;
    if (versionRoot !== null) return present(path.join(versionRoot, RUNTIME_MANIFEST_FILENAME));
    const pointer = path.join(appDataRoot, "native", RUNTIME_CURRENT_FILENAME);
    return existsSync(pointer)
      ? { ok: false, detail: `${pointer} does not select a valid runtime manifest` }
      : { ok: false, absent: true, detail: `${pointer} is not there` };
  };

  const probes: DoctorProbes = {
    appDataWritable: () => {
      try {
        accessSync(appDataRoot, constants.R_OK | constants.W_OK);
        const mode = statSync(appDataRoot).mode & 0o777;
        return Promise.resolve(process.platform === "win32" || mode === 0o700
          ? { ok: true }
          : { ok: false, detail: `mode is ${mode.toString(8)}, expected 700` });
      } catch (error) {
        return Promise.resolve({ ok: false, detail: (error as Error).message });
      }
    },

    databaseMigration: () => {
      try {
        // The schema first, then the integrity check. `foreign_key_check` alone
        // is happy with an empty database, so on its own it would call an
        // unmigrated install healthy — which is exactly the install where
        // every later check reads from a table that is not there.
        const applied = database.$client.prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
        ).get() as { count?: number } | undefined;
        if (applied?.count !== 1) {
          return Promise.resolve({
            ok: false,
            absent: true,
            detail: "the database has not been migrated",
          });
        }
        const violations = database.$client.prepare("PRAGMA foreign_key_check").all();
        return Promise.resolve(violations.length === 0
          ? { ok: true }
          : { ok: false, detail: `${violations.length} foreign key violations` });
      } catch (error) {
        return Promise.resolve({ ok: false, detail: (error as Error).message });
      }
    },

    runtimeManifest: () => Promise.resolve(manifestProbe()),
    runtimeIntegrity: async (deep) => {
      if (!deep) return { ok: true };
      if (publicationFailure !== null) return publicationFailure;
      if (published === null) {
        const manifest = manifestProbe();
        return manifest.ok
          ? {
              ok: false,
              detail: "deep integrity requires a verified current runtime publication",
            }
          : manifest;
      }
      try {
        const inspected = await inspectPublishedRuntimeIntegrity(published);
        if (inspected.ok) {
          return {
            ok: true,
            detail: `verified ${inspected.files} files across ${inspected.archives} runtime archives`,
          };
        }
        const { issue } = inspected;
        const comparison = issue.expected === undefined
          ? ""
          : `; expected ${issue.expected}, found ${issue.actual ?? "unknown"}`;
        return {
          ok: false,
          detail: `${issue.archiveKey}:${issue.path} failed integrity (${issue.reason})${comparison}`,
        };
      } catch (error) {
        const code = errorCode(error);
        return {
          ok: false,
          detail: `runtime payload could not be read during deep integrity${code === null ? "" : ` (${code})`}`,
          remedy: "restore read access to app-data, then rerun `vidcom doctor --deep`",
        };
      }
    },
    ffmpeg: () => Promise.resolve(runtimePaths
      ? runs(executable(runtimePaths.nativeDependenciesRoot, "bin", "ffmpeg"), ["-version"], caBundlePath)
      : unavailableRuntime("FFmpeg")),
    esbuildBinary: () => Promise.resolve(runtimePaths
      ? present(executable(runtimePaths.nativeDependenciesRoot, "bin", "esbuild"))
      : unavailableRuntime("esbuild")),
    compilerProbe: async () => {
      if (!compilerGuard) return unavailableRuntime("compiler");
      const result = await compilerGuard.probe(PROBE_TIMEOUT_MS);
      return result.ok
        ? { ok: true, detail: result.value }
        : { ok: false, detail: `${result.error.code}: ${result.error.message}` };
    },
    hyperframes: () => Promise.resolve(runtimePaths
      ? present(runtimePaths.hyperframesPackagePath)
      : unavailableRuntime("HyperFrames")),
    motionLibraries: () => Promise.resolve(runtimePaths
      ? present(runtimePaths.motionLibraryRoot)
      : unavailableRuntime("motion libraries")),
    pythonStack: () => Promise.resolve(runtimePaths
      ? runs(
          executable(
            runtimePaths.nativeDependenciesRoot,
            "python",
            process.platform === "win32" ? "python" : path.join("bin", "python3"),
          ),
          ["-c", "import importlib.metadata as m; print(len(list(m.distributions())))"],
          caBundlePath,
        )
      : unavailableRuntime("frozen Python")),
    pythonUtf8: () => {
      if (!runtimePaths) return Promise.resolve(unavailableRuntime("frozen Python"));
      const result = runs(
        executable(
          runtimePaths.nativeDependenciesRoot,
          "python",
          process.platform === "win32" ? "python" : path.join("bin", "python3"),
        ),
        ["-c", "print('xin chào tiếng Việt')"],
        caBundlePath,
      );
      if (!result.ok) return Promise.resolve(result);
      // Read back rather than trust the exit code: a frozen interpreter takes
      // its encoding from the ANSI codepage, and the failure that matters is
      // mangled output, not a non-zero status.
      return Promise.resolve(result.detail?.includes("chào")
        ? { ok: true }
        : { ok: false, detail: `interpreter wrote ${JSON.stringify(result.detail)}` });
    },
    chromeCache: async () => {
      if (!runtimePaths) return unavailableRuntime("Chromium cache");
      const status = await downloads.status(DOWNLOAD_CACHE_COMPONENTS.browser);
      if (status.state === "partial") {
        return {
          ok: false,
          detail: status.failureCode === undefined
            ? "the managed Chromium download is partial"
            : `${status.failureCode}: the managed Chromium download is partial`,
        };
      }
      const chrome = await resolveChrome({
        browserCacheRoot: runtimePaths.browserCacheRoot,
        ...process.env.CHROME_PATH?.trim()
          ? { chromePathOverride: process.env.CHROME_PATH.trim() }
          : {},
      });
      return chrome
        ? { ok: true, detail: chrome.version, version: chrome.version }
        : {
            ok: false,
            ...(status.state === "missing" ? { absent: true } : {}),
            detail: status.state === "missing"
              ? "no managed Chromium download exists"
              : "the managed Chromium download contains no runnable browser",
          };
    },
    ttsModelCache: async () => {
      const status = await downloads.status(DOWNLOAD_CACHE_COMPONENTS.models);
      if (status.state !== "ready") {
        return {
          ok: false,
          ...(status.state === "missing" ? { absent: true } : {}),
          detail: status.state === "missing"
            ? "no VieNeu model download exists"
            : status.failureCode === undefined
              ? "the VieNeu model download is partial"
              : `${status.failureCode}: the VieNeu model download is partial`,
        };
      }
      if (!vieneuProbe) return unavailableRuntime("VieNeu model cache verification");
      try {
        const provider = await vieneuProbe.describe();
        return provider.available
          ? { ok: true }
          : { ok: false, detail: "the VieNeu model cache could not pass a warm-offline probe" };
      } catch (error) {
        const code = error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
        return {
          ok: false,
          detail: code === null
            ? "the VieNeu model cache could not pass a warm-offline probe"
            : `${code}: the VieNeu model cache could not pass a warm-offline probe`,
        };
      }
    },

    activeWorkspace: () => {
      const active = readSetting(appSettings, "active_workspace");
      if (active === null) {
        return Promise.resolve({ ok: false, absent: true, detail: "no workspace is recorded" });
      }
      return Promise.resolve(existsSync(active)
        ? { ok: true, detail: active }
        : { ok: false, detail: `${active} is not readable` });
    },

    loopbackPort: loopbackBindable,

    settingsFile: () => {
      // Never reads the contents into the report: the file holds API keys, and
      // doctor output is what users paste into public issues.
      const caBundle = settings?.runtime?.caBundlePath ?? null;
      if (caBundle === null) return Promise.resolve({ ok: true });
      return Promise.resolve(existsSync(caBundle)
        ? { ok: true }
        : { ok: false, detail: "the configured CA bundle path does not exist" });
    },

    elevenLabsKey: () => Promise.resolve(
      settings?.tts?.elevenlabs?.apiKey
        ? { ok: true }
        : { ok: false, absent: true, detail: "no key configured" },
    ),
  };

  const history: DoctorHistory = {
    hasRenderedBefore: () => Promise.resolve(hasTerminalJob(database, ["render", "snapshot"])),
    hasSynthesisedBefore: () => Promise.resolve(hasTerminalJob(database, ["tts"])),
    hasChosenWorkspace: () => Promise.resolve(readSetting(appSettings, "active_workspace") !== null),
    hasSettingsFile: () => Promise.resolve(settings !== null),
  };

  return {
    platform: `${process.platform}-${process.arch}`,
    deep: options.deep,
    appDataRoot,
    probes,
    history,
    close: () => database.destroy(),
  };
}

/**
 * Reads a setting from a database that may not have the table yet.
 *
 * `doctor` is the command people run when the install is broken, so every probe
 * has to survive the broken case. A missing table means "nothing recorded",
 * which is what an unmigrated install actually has.
 */
function readSetting(settings: AppSettingsStore, key: string): string | null {
  try {
    return settings.get(key);
  } catch {
    return null;
  }
}

/** Read from the job table, which already records this. No new table for it. */
function hasTerminalJob(
  database: ReturnType<typeof openVidcomDatabase>,
  types: readonly string[],
): boolean {
  try {
    const placeholders = types.map(() => "?").join(", ");
    const row = database.$client.prepare(
      `SELECT 1 AS present FROM job WHERE type IN (${placeholders})`
      + " AND status IN ('succeeded', 'failed', 'cancelled') LIMIT 1",
    ).get(...types) as { present?: number } | undefined;
    return row?.present === 1;
  } catch {
    // No job table means nothing has ever run here, which is the same answer a
    // healthy empty install gives. Doctor is the command people reach for when
    // the install is broken, so every probe has to survive the broken case
    // rather than take the whole report down with it.
    return false;
  }
}
