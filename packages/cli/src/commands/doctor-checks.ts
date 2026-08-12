import type { DoctorCheck, DoctorItem } from "@vidcom/core";

/**
 * Everything the checks are allowed to look at.
 *
 * Injected rather than reached for, so every check is exercisable without the
 * machine being in the state it describes — which is the only way to test the
 * failure branches, and the failure branches are the whole point of `doctor`.
 */
export interface DoctorContext {
  platform: string;
  deep: boolean;
  appDataRoot: string;
  /** Filesystem and process probes, each returning a plain answer. */
  probes: DoctorProbes;
  /** Facts that decide whether a check has anything to say yet. */
  history: DoctorHistory;
}

export interface ProbeResult {
  ok: boolean;
  detail?: string;
  version?: string;
  /** Overrides the check's generic remedy when the probe knows a safer next step. */
  remedy?: string;
  /** The thing is not there at all, as opposed to there and wrong. */
  absent?: boolean;
}

export interface DoctorProbes {
  appDataWritable(): Promise<ProbeResult>;
  databaseMigration(): Promise<ProbeResult>;
  runtimeManifest(): Promise<ProbeResult>;
  runtimeIntegrity(deep: boolean): Promise<ProbeResult>;
  ffmpeg(): Promise<ProbeResult>;
  esbuildBinary(): Promise<ProbeResult>;
  compilerProbe(): Promise<ProbeResult>;
  hyperframes(): Promise<ProbeResult>;
  motionLibraries(): Promise<ProbeResult>;
  /** Whether the shipped background-music audio was extracted with the runtime. */
  bgmAudio(): Promise<ProbeResult>;
  pythonStack(): Promise<ProbeResult>;
  pythonUtf8(): Promise<ProbeResult>;
  chromeCache(): Promise<ProbeResult>;
  ttsModelCache(): Promise<ProbeResult>;
  activeWorkspace(): Promise<ProbeResult>;
  loopbackPort(): Promise<ProbeResult>;
  settingsFile(): Promise<ProbeResult>;
  elevenLabsKey(): Promise<ProbeResult>;
}

/**
 * What has actually happened on this install.
 *
 * Every one of these is read from data that already exists — the `job` table
 * and `app_settings` — because a `skipped` that is guessed is a `skipped`
 * nobody can trust, and there is no new table for any of it.
 */
export interface DoctorHistory {
  hasRenderedBefore(): Promise<boolean>;
  hasSynthesisedBefore(): Promise<boolean>;
  hasChosenWorkspace(): Promise<boolean>;
  hasSettingsFile(): Promise<boolean>;
}

function itemFrom(id: string, result: ProbeResult, remedy: string): DoctorItem {
  if (result.ok) {
    return { id, status: "ok", ...(result.detail === undefined ? {} : { detail: result.detail }) };
  }
  return {
    id,
    // `missing` when it is not there at all, `broken` when it is there and
    // wrong. The two need different fixes — re-extract versus investigate — and
    // collapsing them makes every remedy a guess.
    status: result.absent === true ? "missing" : "broken",
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    remedy: result.remedy ?? remedy,
  };
}

function check(
  id: string,
  required: boolean,
  run: (context: DoctorContext) => Promise<DoctorItem>,
): DoctorCheck<DoctorContext> {
  return { id, required, run };
}

const REPAIR_REMEDY = "run `vidcom doctor --repair` to re-extract the runtime";

export function createDoctorChecks(): DoctorCheck<DoctorContext>[] {
  return [
    check("app-data.writable", true, async (context) =>
      itemFrom(
        "app-data.writable",
        await context.probes.appDataWritable(),
        `check permissions on ${context.appDataRoot}`,
      )),

    check("db.migration", true, async (context) =>
      itemFrom(
        "db.migration",
        await context.probes.databaseMigration(),
        "the database is behind or inconsistent; restore a backup, or report this",
      )),

    check("runtime.manifest", true, async (context) =>
      itemFrom("runtime.manifest", await context.probes.runtimeManifest(), REPAIR_REMEDY)),

    check("runtime.integrity", true, async (context) => {
      if (!context.deep) {
        // Not a failure: hashing every extracted file costs seconds, so the
        // shallow run reads the markers and says plainly that it did.
        return {
          id: "runtime.integrity",
          status: "skipped",
          detail: "markers only; pass --deep to hash every extracted file",
          // Carried on the skip so a strict run, which promotes it, still says
          // the one thing that fixes it. This skip means "a different mode was
          // asked for", not "never exercised".
          remedy: "run `vidcom doctor --deep` to hash every extracted file",
        };
      }
      return itemFrom("runtime.integrity", await context.probes.runtimeIntegrity(true), REPAIR_REMEDY);
    }),

    check("runtime.ffmpeg", true, async (context) =>
      itemFrom("runtime.ffmpeg", await context.probes.ffmpeg(), REPAIR_REMEDY)),

    check("runtime.esbuild-binary", true, async (context) =>
      itemFrom("runtime.esbuild-binary", await context.probes.esbuildBinary(), REPAIR_REMEDY)),

    check("compiler.probe", true, async (context) =>
      // Runs a real transform through the CompilerGuard and its timeout. Without
      // the guard this is precisely the check that hangs forever with no output,
      // which is worse than any answer it could give.
      itemFrom("compiler.probe", await context.probes.compilerProbe(), REPAIR_REMEDY)),

    check("runtime.hyperframes", true, async (context) =>
      itemFrom("runtime.hyperframes", await context.probes.hyperframes(), REPAIR_REMEDY)),

    check("runtime.motion", true, async (context) =>
      itemFrom("runtime.motion", await context.probes.motionLibraries(), REPAIR_REMEDY)),

    check("runtime.bgm", true, async (context) =>
      itemFrom("runtime.bgm", await context.probes.bgmAudio(), REPAIR_REMEDY)),

    check("runtime.python", true, async (context) =>
      // Listed with `importlib.metadata`, which is standard library. pip was
      // removed from the shipped stack, so a check that needed it would fail on
      // every healthy install.
      itemFrom("runtime.python", await context.probes.pythonStack(), REPAIR_REMEDY)),

    check("runtime.python-utf8", true, async (context) =>
      // Prints a Vietnamese string through the shipped interpreter and reads it
      // back. A frozen interpreter takes its encoding from the ANSI codepage,
      // and the failure this catches is a UnicodeEncodeError at synthesis time.
      itemFrom(
        "runtime.python-utf8",
        await context.probes.pythonUtf8(),
        "the shipped interpreter is not writing UTF-8; report this with the detail above",
      )),

    check("chrome.cache", true, async (context) => {
      if (!await context.history.hasRenderedBefore()) {
        return { id: "chrome.cache", status: "skipped", detail: "nothing has rendered on this install yet" };
      }
      // Executes the binary. Asking the CLI for a path proves nothing: a
      // truncated 1 MB Chrome still resolves to a path and exits 0, then kills
      // a render with an unrelated error.
      return itemFrom(
        "chrome.cache",
        await context.probes.chromeCache(),
        "the browser download is incomplete; render once with a network connection to fetch it again",
      );
    }),

    check("tts.model-cache", true, async (context) => {
      if (!await context.history.hasSynthesisedBefore()) {
        return { id: "tts.model-cache", status: "skipped", detail: "no speech has been synthesised yet" };
      }
      return itemFrom(
        "tts.model-cache",
        await context.probes.ttsModelCache(),
        "the voice model is incomplete; synthesise once with a network connection",
      );
    }),

    check("workspace.active", true, async (context) => {
      if (!await context.history.hasChosenWorkspace()) {
        return { id: "workspace.active", status: "skipped", detail: "no workspace has been chosen yet" };
      }
      return itemFrom(
        "workspace.active",
        await context.probes.activeWorkspace(),
        "the saved workspace is unreadable; choose one again in the app",
      );
    }),

    check("port.available", true, async (context) =>
      itemFrom(
        "port.available",
        await context.probes.loopbackPort(),
        "nothing can bind a loopback port; check a firewall or a security product",
      )),

    check("settings.file", false, async (context) => {
      if (!await context.history.hasSettingsFile()) {
        return { id: "settings.file", status: "skipped", detail: "no settings file has been written" };
      }
      // Never prints the file. It holds API keys, and doctor output is the one
      // thing users paste into public issues.
      return itemFrom(
        "settings.file",
        await context.probes.settingsFile(),
        "the settings file cannot be parsed; fix the JSON or delete it to start again",
      );
    }),

    check("tts.elevenlabs", false, async (context) =>
      itemFrom(
        "tts.elevenlabs",
        await context.probes.elevenLabsKey(),
        "add an ElevenLabs API key in the settings file to use that voice provider",
      )),
  ];
}

export function doctorCheckIsRequired(id: string): boolean {
  return !["settings.file", "tts.elevenlabs"].includes(id);
}
