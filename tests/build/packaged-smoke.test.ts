import { readFile } from "node:fs/promises";

import {
  SMOKE_STEPS,
  failedStepIds,
  parseSmokeArgs,
  selectSteps,
  smokeExitCode,
  stepIds,
} from "../../scripts/packaged-smoke/steps.mjs";
import { describe, expect, it } from "vitest";

interface StepResult {
  id: string;
  required: boolean;
  status: "passed" | "failed" | "skipped";
}

function results(entries: Array<Partial<StepResult> & { id: string }>): StepResult[] {
  return entries.map((entry) => ({ required: true, status: "passed", ...entry }));
}

describe("packaged smoke steps", () => {
  it("runs the matrix from Design §11.4 in order", () => {
    expect(stepIds()).toEqual([
      "build",
      "clean-environment",
      "restore-caches",
      "identify",
      "ui-lifecycle",
      "import",
      "bridge",
      "render-media",
      "upload-and-progress",
      "render-cli",
      "offline",
      "lease-loss",
      "provenance",
    ]);
  });

  it("treats every step as required", () => {
    // The phase's criterion is that no required step was skipped. A step that
    // was optional would be one nobody notices going quiet.
    expect(SMOKE_STEPS.every((step) => step.required)).toBe(true);
  });

  it("is wired as a script that runs on a developer's machine too", async () => {
    // A smoke that only runs in Actions means every fix to a step costs a push,
    // and after a while nobody fixes them.
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["test:packaged-smoke"]).toBe("node scripts/packaged-smoke/run.mjs");
  });
});

describe("packaged smoke selection", () => {
  it("runs one step, or everything from one step on", () => {
    expect(selectSteps({ step: "bridge" }).map((step) => step.id)).toEqual(["bridge"]);
    expect(selectSteps({ from: "offline" }).map((step) => step.id))
      .toEqual(["offline", "lease-loss", "provenance"]);
    expect(selectSteps({})).toHaveLength(SMOKE_STEPS.length);
  });

  it("refuses a step id that does not exist", () => {
    expect(() => selectSteps({ step: "renders" })).toThrow(/unknown smoke step/u);
    expect(() => parseSmokeArgs(["--step"])).toThrow(/requires a step id/u);
    expect(() => parseSmokeArgs(["--step", "a", "--from", "b"])).toThrow(/cannot be combined/u);
    expect(() => parseSmokeArgs(["--quick"])).toThrow(/unknown smoke argument/u);
  });
});

describe("packaged smoke outcome", () => {
  it("fails on a failed step and names it", () => {
    // Thirteen steps and one "smoke failed" is a report somebody has to
    // reproduce locally before they can even read it.
    const outcome = results([{ id: "bridge", status: "failed" }, { id: "offline" }]);
    expect(smokeExitCode(outcome)).toBe(1);
    expect(failedStepIds(outcome)).toEqual(["bridge"]);
  });

  it("lets a skip pass outside the job, and fail inside it", () => {
    // R8.4 says a missing required component fails the job rather than
    // skipping. Outside the job a skip still means "not reached yet", so the
    // difference is a flag rather than two different meanings of skipped.
    const outcome = results([{ id: "render-media", status: "skipped" }]);
    expect(smokeExitCode(outcome)).toBe(0);
    expect(smokeExitCode(outcome, { strict: true })).toBe(1);
    expect(failedStepIds(outcome, { strict: true })).toEqual(["render-media"]);
  });

  it("takes strict from the environment the job already sets", () => {
    const previous = process.env.VIDCOM_DOCTOR_STRICT;
    process.env.VIDCOM_DOCTOR_STRICT = "1";
    try {
      expect(parseSmokeArgs([]).strict).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.VIDCOM_DOCTOR_STRICT;
      else process.env.VIDCOM_DOCTOR_STRICT = previous;
    }
  });
});
