import { DOCTOR_CHECK_ORDER, runDoctorChecks } from "@vidcom/core";
import {
  createDoctorChecks,
  type DoctorContext,
  type DoctorProbes,
  type ProbeResult,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

const PROBE_NAMES = [
  "appDataWritable", "databaseMigration", "runtimeManifest", "runtimeIntegrity",
  "ffmpeg", "esbuildBinary", "compilerProbe", "hyperframes", "motionLibraries",
  "pythonStack", "pythonUtf8", "chromeCache", "ttsModelCache", "activeWorkspace",
  "loopbackPort", "settingsFile", "elevenLabsKey",
] as const;

function probes(result: ProbeResult): DoctorProbes {
  const base: Record<string, () => Promise<ProbeResult>> = {};
  for (const name of PROBE_NAMES) base[name] = () => Promise.resolve(result);
  return base as unknown as DoctorProbes;
}

function context(result: ProbeResult, everythingDone: boolean): DoctorContext {
  return {
    platform: "linux-x64",
    deep: true,
    appDataRoot: "/app-data",
    probes: probes(result),
    history: {
      hasRenderedBefore: () => Promise.resolve(everythingDone),
      hasSynthesisedBefore: () => Promise.resolve(everythingDone),
      hasChosenWorkspace: () => Promise.resolve(everythingDone),
      hasSettingsFile: () => Promise.resolve(everythingDone),
    },
  };
}

/**
 * The payload people paste into bug reports, written out in full.
 *
 * Deriving the expectation from the same code that builds it would prove
 * nothing. Writing it out means a reordered check, a renamed id or a changed
 * status vocabulary all show up here as a diff somebody has to justify.
 */
describe("doctor --json", () => {
  it("reports a healthy install in exactly this order and shape", async () => {
    const report = await runDoctorChecks(createDoctorChecks(), context({ ok: true }, true), {
      platform: "linux-x64",
    });
    expect(report).toEqual({
      version: 1,
      platform: "linux-x64",
      items: [
        { id: "app-data.writable", status: "ok" },
        { id: "db.migration", status: "ok" },
        { id: "runtime.manifest", status: "ok" },
        { id: "runtime.integrity", status: "ok" },
        { id: "runtime.ffmpeg", status: "ok" },
        { id: "runtime.esbuild-binary", status: "ok" },
        { id: "compiler.probe", status: "ok" },
        { id: "runtime.hyperframes", status: "ok" },
        { id: "runtime.motion", status: "ok" },
        { id: "runtime.python", status: "ok" },
        { id: "runtime.python-utf8", status: "ok" },
        { id: "chrome.cache", status: "ok" },
        { id: "tts.model-cache", status: "ok" },
        { id: "workspace.active", status: "ok" },
        { id: "port.available", status: "ok" },
        { id: "settings.file", status: "ok" },
        { id: "tts.elevenlabs", status: "ok" },
      ],
    });
  });

  it("keeps the same order and ids on a fresh install that has done nothing", async () => {
    const report = await runDoctorChecks(createDoctorChecks(), context({ ok: true }, false), {
      platform: "linux-x64",
    });
    expect(report.items.map((item) => `${item.id}=${item.status}`)).toEqual([
      "app-data.writable=ok",
      "db.migration=ok",
      "runtime.manifest=ok",
      "runtime.integrity=ok",
      "runtime.ffmpeg=ok",
      "runtime.esbuild-binary=ok",
      "compiler.probe=ok",
      "runtime.hyperframes=ok",
      "runtime.motion=ok",
      "runtime.python=ok",
      "runtime.python-utf8=ok",
      "chrome.cache=skipped",
      "tts.model-cache=skipped",
      "workspace.active=skipped",
      "port.available=ok",
      "settings.file=skipped",
      "tts.elevenlabs=ok",
    ]);
  });

  it("names every check exactly once", () => {
    // A duplicate id would give one component two rows with different verdicts,
    // and nothing downstream could say which one to believe.
    const ids = createDoctorChecks().map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...DOCTOR_CHECK_ORDER].sort());
  });

  it("uses only the four statuses the contract publishes", async () => {
    const report = await runDoctorChecks(
      createDoctorChecks(),
      context({ ok: false, detail: "broken" }, true),
      { platform: "linux-x64" },
    );
    for (const item of report.items) {
      expect(["ok", "missing", "broken", "skipped"], item.id).toContain(item.status);
    }
  });
});
