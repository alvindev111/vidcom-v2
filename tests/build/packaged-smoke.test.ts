import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SMOKE_STEPS,
  failedStepIds,
  parseSmokeArgs,
  selectSteps,
  smokeExitCode,
  stepIds,
} from "../../scripts/packaged-smoke/steps.mjs";
import {
  macNetworkCutRoutes,
  networkCutPlan,
} from "../../scripts/packaged-smoke/network-cut.mjs";
import { copyCacheContents } from "../../scripts/packaged-smoke/environment.mjs";
import { browsePathSegments, browseSegmentMatches } from "../../scripts/packaged-smoke/bodies.mjs";
import { PACKAGED_RUNTIME_SOURCES } from "../../scripts/prepare-packaged-runtime.mjs";
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
  it("walks canonical Windows paths without preserving 8.3 aliases or display casing", () => {
    expect(browsePathSegments(
      "C:\\",
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\imported-project",
      "win32",
    )).toEqual(["Users", "runneradmin", "AppData", "Local", "Temp", "imported-project"]);
    expect(browseSegmentMatches("RunnerAdmin", "runneradmin", "win32")).toBe(true);
    expect(browsePathSegments("D:\\workspace", "C:\\outside", "win32")).toBeNull();
  });

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

  it("ships the zip extractor required by a clean machine", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies.yauzl).toBe("3.4.0");
  });

  it("does not turn an empty restored cache into a ready component", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-empty-cache-"));
    try {
      await copyCacheContents(path.join(root, "missing"), path.join(root, "browser-cache"));
      await expect(stat(path.join(root, "browser-cache"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps model-cache symlinks portable across smoke roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-linked-cache-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      await mkdir(path.join(source, "snapshots", "revision"), { recursive: true });
      await mkdir(path.join(source, "blobs"), { recursive: true });
      await writeFile(path.join(source, "blobs", "model"), "weights", "utf8");
      await symlink("../../blobs/model", path.join(source, "snapshots", "revision", "model"));
      await copyCacheContents(source, destination);
      expect(await readlink(path.join(destination, "snapshots", "revision", "model")))
        .toBe(path.normalize("../../blobs/model"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("native packaged-smoke inputs", () => {
  it("pins one exact Python and non-release media fixture for every smoke platform", () => {
    expect(Object.keys(PACKAGED_RUNTIME_SOURCES).sort()).toEqual([
      "darwin-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    for (const source of Object.values(PACKAGED_RUNTIME_SOURCES)) {
      for (const asset of [source.python, source.ffmpeg, source.ffprobe]) {
        expect(asset.url).toMatch(/^https:\/\/github\.com\//u);
        expect(asset.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
      }
      expect(source.evidence).toMatch(/-package-set(?:-pruned)?\.txt$/u);
    }
  });

  it("requires the workflow to opt in to the unapproved smoke-only media source", async () => {
    const workflow = await readFile(".github/workflows/packaged-smoke.yml", "utf8");
    expect(workflow).toContain('VIDCOM_ALLOW_UNRELEASED_SMOKE_RUNTIME: "1"');
    expect(workflow).toContain("Production FFmpeg acquisition remains behind the human supply-chain gate");
  });

  it("does not duplicate pull-request heavy workflows through the CI wrapper", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow.match(/if: github\.event_name == 'workflow_dispatch'/gu)).toHaveLength(2);
    expect(workflow).not.toContain(
      "github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request'",
    );
  });

  it("has an explicit runner-level network cut for each release platform", () => {
    expect(networkCutPlan("darwin")).toContain("reject routes");
    expect(networkCutPlan("linux")).toContain("iptables");
    expect(networkCutPlan("win32")).toContain("firewall rule");
    expect(() => networkCutPlan("freebsd")).toThrow(/no runner network cut/u);
  });

  it("makes macOS external routes reject immediately instead of looping until browser timeout", () => {
    const routes = macNetworkCutRoutes();
    expect(routes).toHaveLength(4);
    for (const route of routes) {
      expect(route.add.at(-1)).toBe("-reject");
      expect(route.delete).not.toContain("-reject");
    }
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
