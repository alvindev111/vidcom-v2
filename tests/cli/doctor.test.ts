import {
  DOCTOR_CHECK_ORDER,
  doctorExitCode,
  redactDoctorReport,
  runDoctorChecks,
  type DoctorReport,
} from "@vidcom/core";
import {
  CliInputError,
  createDoctorChecks,
  doctorCheckIsRequired,
  doctorNeedsDeepProbe,
  parseDoctorCommandArgs,
  repairRuntime,
  runDoctor,
  type DoctorContext,
  type DoctorProbes,
  type ProbeResult,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

const HEALTHY: ProbeResult = { ok: true };

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const base = {} as Record<string, () => Promise<ProbeResult>>;
  for (const name of [
    "appDataWritable", "databaseMigration", "runtimeManifest", "runtimeIntegrity",
    "ffmpeg", "esbuildBinary", "compilerProbe", "hyperframes", "motionLibraries", "bgmAudio",
    "pythonStack", "pythonUtf8", "chromeCache", "ttsModelCache", "activeWorkspace",
    "loopbackPort", "settingsFile", "elevenLabsKey",
  ]) base[name] = () => Promise.resolve(HEALTHY);
  return { ...(base as unknown as DoctorProbes), ...overrides };
}

function context(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    platform: "darwin-arm64",
    deep: false,
    appDataRoot: "/app-data",
    probes: probes(),
    history: {
      hasRenderedBefore: () => Promise.resolve(true),
      hasSynthesisedBefore: () => Promise.resolve(true),
      hasChosenWorkspace: () => Promise.resolve(true),
      hasSettingsFile: () => Promise.resolve(true),
    },
    ...overrides,
  };
}

function capture(): { io: { stdout: Sink; stderr: Sink }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: { write: (chunk: string) => { out.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { err.push(chunk); return true; } },
    },
  };
}

interface Sink { write(chunk: string): boolean }

async function report(input: Partial<DoctorContext> = {}, strict = false): Promise<DoctorReport> {
  return runDoctorChecks(createDoctorChecks(), context(input), {
    platform: "darwin-arm64",
    strict,
  });
}

describe("doctor framework", () => {
  it("uses an integrity probe for both explicit deep checks and repair", () => {
    expect(doctorNeedsDeepProbe({})).toBe(false);
    expect(doctorNeedsDeepProbe({ deep: true })).toBe(true);
    expect(doctorNeedsDeepProbe({ repair: true })).toBe(true);
  });

  it("reports in a fixed order that does not follow import order", async () => {
    // Registration order follows import order, and nobody controls that. The
    // golden report pins this list, so a check that moves has to move here.
    expect((await report()).items.map((item) => item.id)).toEqual([...DOCTOR_CHECK_ORDER]);
  });

  it("has no gpu.cuda check", () => {
    // The shipped stack is CPU-only onnxruntime, so it could never return ok —
    // and an item that is permanently not-ok teaches people to ignore the whole
    // report.
    expect(DOCTOR_CHECK_ORDER).not.toContain("gpu.cuda");
  });

  it("runs every check even after one fails", async () => {
    // Somebody running doctor wants the whole picture. Stopping at the first
    // failure turns one broken install into as many runs as it has problems.
    const items = (await report({
      probes: probes({ ffmpeg: () => Promise.resolve({ ok: false, detail: "not executable" }) }),
    })).items;
    expect(items).toHaveLength(DOCTOR_CHECK_ORDER.length);
    expect(items.find((item) => item.id === "runtime.ffmpeg")?.status).toBe("broken");
  });

  it("turns a check that throws into a broken item rather than losing the report", async () => {
    const items = (await report({
      probes: probes({ pythonStack: () => Promise.reject(new Error("interpreter vanished")) }),
    })).items;
    expect(items.find((item) => item.id === "runtime.python")).toMatchObject({
      status: "broken",
      detail: "interpreter vanished",
    });
    expect(items).toHaveLength(DOCTOR_CHECK_ORDER.length);
  });

  it("gives every non-ok item something to do about it", async () => {
    const items = (await report({
      probes: probes({
        ffmpeg: () => Promise.resolve({ ok: false, detail: "not executable" }),
        elevenLabsKey: () => Promise.resolve({ ok: false, detail: "no key configured" }),
      }),
    })).items;
    for (const item of items) {
      if (item.status === "ok" || item.status === "skipped") continue;
      expect(item.remedy, item.id).toBeTruthy();
    }
  });
});

describe("doctor skips", () => {
  it("skips only what this install has never done", async () => {
    // Read from data that already exists — the job table and app_settings —
    // because a guessed `skipped` is one nobody can trust.
    const items = (await report({
      history: {
        hasRenderedBefore: () => Promise.resolve(false),
        hasSynthesisedBefore: () => Promise.resolve(false),
        hasChosenWorkspace: () => Promise.resolve(false),
        hasSettingsFile: () => Promise.resolve(false),
      },
    })).items;
    const status = (id: string) => items.find((item) => item.id === id)?.status;
    expect(status("chrome.cache")).toBe("skipped");
    expect(status("tts.model-cache")).toBe("skipped");
    expect(status("workspace.active")).toBe("skipped");
    expect(status("settings.file")).toBe("skipped");
  });

  it("hashes every file only when asked", async () => {
    expect((await report()).items.find((item) => item.id === "runtime.integrity")?.status)
      .toBe("skipped");
    expect((await report({ deep: true })).items.find((item) => item.id === "runtime.integrity")?.status)
      .toBe("ok");
  });

  it("still says what to do when strict promotes a skip", async () => {
    // Every other not-ok item carries a remedy, and a strict run producing the
    // one line that does not is the run where somebody most needs the answer.
    const items = (await report({}, true)).items;
    for (const item of items) {
      if (item.status === "ok" || item.status === "skipped") continue;
      expect(item.remedy, item.id).toBeTruthy();
    }
    expect(items.find((item) => item.id === "runtime.integrity")?.remedy).toContain("--deep");
  });

  it("still reports when the repair itself cannot run", async () => {
    // Found by the packaged smoke: `--repair` threw before anything was
    // printed, so the one command whose job is to say what is wrong said
    // nothing at all. The diagnosis has to survive a repair that fails, and the
    // reason belongs on the item it was meant to fix.
    const output = capture();
    await runDoctor({
      context: context({
        probes: probes({
          ffmpeg: () => Promise.resolve({ ok: false, detail: "no ffmpeg" }),
        }),
      }),
      options: { json: true, repair: true },
      repair: () => Promise.reject(new Error("no runtime archives to re-extract from")),
      io: output.io,
    });
    const report = JSON.parse(output.out.join("")) as {
      items: Array<{ status: string; remedy?: string }>;
    };
    expect(report.items.length).toBeGreaterThan(0);
    const broken = report.items.filter((item) => item.status !== "ok" && item.status !== "skipped");
    expect(broken.length).toBeGreaterThan(0);
    for (const item of broken) expect(item.remedy).toContain("repair failed");
  });

  it("does not repair a shallow skip merely because strict promotes it", async () => {
    const output = capture();
    let repairInput: readonly { id: string }[] = [];
    await runDoctor({
      context: context(),
      options: { json: true, repair: true },
      strict: true,
      repair: async (failing) => {
        repairInput = failing;
        return { items: [] };
      },
      io: output.io,
    });

    expect(repairInput.map((item) => item.id)).not.toContain("runtime.integrity");
    const printed = JSON.parse(output.out.join("")) as DoctorReport;
    expect(printed.items.find((item) => item.id === "runtime.integrity")).toMatchObject({
      status: "missing",
      remedy: expect.stringContaining("--deep"),
    });
  });

  it("counts a skipped required item as missing under strict", async () => {
    // R8.4 says the packaged smoke fails when a required component is absent,
    // while the exit rule says skipped is not a failure. Strict mode is where
    // those two meet.
    const items = (await report({
      history: {
        hasRenderedBefore: () => Promise.resolve(false),
        hasSynthesisedBefore: () => Promise.resolve(true),
        hasChosenWorkspace: () => Promise.resolve(true),
        hasSettingsFile: () => Promise.resolve(false),
      },
    }, true)).items;
    expect(items.find((item) => item.id === "chrome.cache")?.status).toBe("missing");
    // Optional items keep their skip: strict is about required components.
    expect(items.find((item) => item.id === "settings.file")?.status).toBe("skipped");
  });
});

describe("doctor exit code", () => {
  it("is zero when everything required is fine", async () => {
    expect(doctorExitCode(await report(), doctorCheckIsRequired)).toBe(0);
  });

  it("is zero when only an optional item is unhappy", async () => {
    // It describes the user's own configuration. Failing the command for it
    // would make doctor useless in a script that asks "can this app run".
    const unhappy = await report({
      probes: probes({ elevenLabsKey: () => Promise.resolve({ ok: false, detail: "no key" }) }),
    });
    expect(doctorExitCode(unhappy, doctorCheckIsRequired)).toBe(0);
  });

  it("is non-zero when something required is wrong", async () => {
    const broken = await report({
      probes: probes({ compilerProbe: () => Promise.resolve({ ok: false, detail: "timed out" }) }),
    });
    expect(doctorExitCode(broken, doctorCheckIsRequired)).not.toBe(0);
  });

  it("is zero when a required item is merely skipped", async () => {
    const skipped = await report({
      history: {
        hasRenderedBefore: () => Promise.resolve(false),
        hasSynthesisedBefore: () => Promise.resolve(false),
        hasChosenWorkspace: () => Promise.resolve(false),
        hasSettingsFile: () => Promise.resolve(true),
      },
    });
    expect(doctorExitCode(skipped, doctorCheckIsRequired)).toBe(0);
  });
});

describe("doctor output", () => {
  it("puts JSON on stdout and prose on stderr", async () => {
    // That is what lets `doctor --json | jq` work while a human still sees
    // something readable.
    const output = capture();
    await runDoctor({ context: context(), options: { json: true }, io: output.io });
    expect(JSON.parse(output.out.join(""))).toMatchObject({ version: 1 });
    expect(output.err.join("")).toBe("");

    const human = capture();
    await runDoctor({ context: context(), options: {}, io: human.io });
    expect(human.out.join("")).toBe("");
    expect(human.err.join("")).toContain("app-data.writable");
  });

  it("keeps a leaked key out of the output people paste into issues", () => {
    const leaky: DoctorReport = {
      version: 1,
      platform: "darwin-arm64",
      items: [
        { id: "tts.elevenlabs", status: "broken", detail: "api_key=sk-live-123", remedy: "add a key" },
        { id: "settings.file", status: "broken", detail: "token: abcdef", remedy: "fix it" },
      ],
    };
    const clean = JSON.stringify(redactDoctorReport(leaky));
    expect(clean).not.toContain("sk-live-123");
    expect(clean).not.toContain("abcdef");
  });

  it("strips the build machine's paths", () => {
    const leaky: DoctorReport = {
      version: 1,
      platform: "darwin-arm64",
      items: [{
        id: "runtime.ffmpeg",
        status: "broken",
        detail: "built at /Users/builder/work/vidcom/dist",
        remedy: "re-extract",
      }],
    };
    // They say nothing about the user's install and everything about ours.
    const clean = redactDoctorReport(leaky, ["/Users/builder/work/vidcom"]);
    expect(clean.items[0]?.detail).not.toContain("/Users/builder");
  });

  it("refuses an argument it does not have", () => {
    expect(() => parseDoctorCommandArgs(["--verbose"])).toThrow(CliInputError);
    expect(() => parseDoctorCommandArgs(["--json", "--json"])).toThrow(CliInputError);
    expect(parseDoctorCommandArgs(["--json", "--deep"])).toEqual({ json: true, deep: true });
  });
});

describe("doctor repair", () => {
  it("hands only the failing items to the repair, and reports what came back", async () => {
    // Repair touches runtime components and nothing else; a report rebuilt from
    // its answers shows the install as it is now, not as a mix of before and
    // after.
    let handed: string[] = [];
    const output = capture();
    const code = await runDoctor({
      context: context({
        probes: probes({ ffmpeg: () => Promise.resolve({ ok: false, detail: "not executable" }) }),
      }),
      options: { repair: true, json: true },
      io: output.io,
      repair: (failing) => {
        handed = failing.map((item) => item.id);
        return Promise.resolve({ items: [{ id: "runtime.ffmpeg", status: "ok" as const }] });
      },
    });
    expect(handed).toEqual(["runtime.ffmpeg"]);
    expect(code).toBe(0);
  });

  it("says so rather than pretending when this build cannot repair", async () => {
    await expect(runDoctor({
      context: context(),
      options: { repair: true },
      io: capture().io,
    })).rejects.toBeInstanceOf(CliInputError);
  });

  it("still fails when the repair did not fix it", async () => {
    const code = await runDoctor({
      context: context({
        probes: probes({ ffmpeg: () => Promise.resolve({ ok: false, detail: "not executable" }) }),
      }),
      options: { repair: true, json: true },
      io: capture().io,
      repair: () => Promise.resolve({
        items: [{
          id: "runtime.ffmpeg",
          status: "broken" as const,
          detail: "the daemon is holding the file",
          remedy: "stop the app and run this again",
        }],
      }),
    });
    expect(code).not.toBe(0);
  });
});

describe("doctor repair scope", () => {
  const failing = [
    { id: "runtime.ffmpeg", status: "missing" as const, detail: "not there", remedy: "re-extract" },
    { id: "settings.file", status: "broken" as const, detail: "bad json", remedy: "fix the JSON" },
  ];

  it("re-extracts runtime components and leaves the user's own files alone", async () => {
    let asked: readonly string[] = [];
    const outcome = await repairRuntime(failing, {
      appDataRoot: "/app-data",
      activeWorkspace: () => Promise.resolve(null),
      reextract: (keys) => { asked = keys; return Promise.resolve(); },
    });
    expect(asked).toEqual(["runtime.ffmpeg"]);
    expect(outcome.items.find((item) => item.id === "runtime.ffmpeg")?.status).toBe("ok");
    // Settings and projects belong to the user; a repair that edited them would
    // be fixing something it was never asked about.
    expect(outcome.items.find((item) => item.id === "settings.file")?.status).toBe("broken");
    expect(outcome.items.find((item) => item.id === "settings.file")?.remedy)
      .toContain("only re-extracts runtime components");
  });

  it("refuses while a daemon is holding the files, rather than swapping half of them", async () => {
    // On Windows the daemon holds the very files a repair replaces, so the swap
    // fails partway and leaves a tree that is neither install. One extra step
    // for the user beats that state.
    let reextracted = false;
    const outcome = await repairRuntime(failing, {
      appDataRoot: "/app-data",
      activeWorkspace: () => Promise.resolve("/w"),
      discovery: {
        read: () => Promise.resolve({
          schemaVersion: 1,
          workspaceRoot: "/w",
          workspaceHash: "sha256:x",
          instanceId: "daemon_first",
          pid: 1,
          host: "127.0.0.1" as const,
          port: 1234,
          startedAt: "2026-08-09T00:00:00.000Z",
        }),
      },
      reextract: () => { reextracted = true; return Promise.resolve(); },
    });
    expect(reextracted).toBe(false);
    expect(outcome.items.find((item) => item.id === "runtime.ffmpeg")?.remedy)
      .toContain("stop the app");
  });

  it("does nothing at all when nothing repairable failed", async () => {
    let reextracted = false;
    const outcome = await repairRuntime([failing[1]!], {
      appDataRoot: "/app-data",
      activeWorkspace: () => Promise.resolve(null),
      reextract: () => { reextracted = true; return Promise.resolve(); },
    });
    expect(reextracted).toBe(false);
    expect(outcome.items).toHaveLength(1);
  });
});
