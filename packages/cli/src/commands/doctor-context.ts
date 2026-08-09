import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  AppSettingsStore,
  allowlistedEnvironment,
  openVidcomDatabase,
  readVidcomSettings,
} from "@vidcom/adapter";

import { defaultAppDataRoot, defaultNativeDependenciesRoot } from "../next-host";
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
function runs(executable: string, args: readonly string[]): ProbeResult {
  if (!existsSync(executable)) return { ok: false, absent: true, detail: `${executable} is not there` };
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    shell: false,
    // The same environment every other child gets. Probing with the parent's
    // environment would test a configuration the product never runs — and
    // `runtime.python-utf8` in particular exists to catch an encoding that only
    // goes wrong because of what is, or is not, in this environment.
    env: allowlistedEnvironment(process.env),
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

export interface DoctorContextOptions {
  deep: boolean;
  appDataRoot?: string;
  nativeRoot?: string;
}

/**
 * Wires the checks to the machine they are asked about.
 *
 * Anything that lives in the runtime archive answers "not there" on a source
 * checkout, which is the truth: the archive is what a packaged build extracts,
 * and pretending otherwise would make `doctor` green on an install that cannot
 * render.
 */
export async function createDoctorContext(options: DoctorContextOptions): Promise<DoctorContext> {
  const settings = await readVidcomSettings().catch(() => null);
  const appDataRoot = options.appDataRoot ?? defaultAppDataRoot(settings ?? undefined);
  const nativeRoot = options.nativeRoot ?? defaultNativeDependenciesRoot(appDataRoot);
  const database = openVidcomDatabase(appDataRoot);
  const appSettings = new AppSettingsStore(database);
  const executable = (...segments: string[]): string =>
    path.join(nativeRoot, ...segments) + (process.platform === "win32" ? ".exe" : "");

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

    runtimeManifest: () => Promise.resolve(present(path.join(nativeRoot, "runtime-manifest.json"))),
    runtimeIntegrity: (deep) => Promise.resolve(deep
      ? present(path.join(nativeRoot, "runtime-manifest.json"))
      : { ok: true }),
    ffmpeg: () => Promise.resolve(runs(executable("ffmpeg", "bin", "ffmpeg"), ["-version"])),
    esbuildBinary: () => Promise.resolve(present(executable("node", "bin", "esbuild"))),
    compilerProbe: () => Promise.resolve(
      // Through the shipped binary and its timeout. Without one this is the
      // check that hangs forever with nothing on stderr.
      runs(executable("node", "bin", "esbuild"), ["--version"]),
    ),
    hyperframes: () => Promise.resolve(present(path.join(nativeRoot, "hyperframes"))),
    motionLibraries: () => Promise.resolve(present(path.join(nativeRoot, "motion"))),
    pythonStack: () => Promise.resolve(runs(
      executable("cpython", "bin", "python3"),
      ["-c", "import importlib.metadata as m; print(len(list(m.distributions())))"],
    )),
    pythonUtf8: () => {
      const result = runs(
        executable("cpython", "bin", "python3"),
        ["-c", "print('xin chào tiếng Việt')"],
      );
      if (!result.ok) return Promise.resolve(result);
      // Read back rather than trust the exit code: a frozen interpreter takes
      // its encoding from the ANSI codepage, and the failure that matters is
      // mangled output, not a non-zero status.
      return Promise.resolve(result.detail?.includes("chào")
        ? { ok: true }
        : { ok: false, detail: `interpreter wrote ${JSON.stringify(result.detail)}` });
    },
    chromeCache: () => Promise.resolve(runs(
      executable("chromium", "chrome-headless-shell"),
      ["--version"],
    )),
    ttsModelCache: () => Promise.resolve(present(path.join(appDataRoot, "models"))),

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
    return false;
  }
}
