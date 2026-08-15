import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const CI_WORKFLOW = ".github/workflows/ci.yml";
const BROWSER_WORKFLOW = ".github/workflows/phase4-browser-session.yml";
const PROCESS_WORKFLOW = ".github/workflows/process-supervision.yml";
const PACKAGED_SMOKE_WORKFLOW = ".github/workflows/packaged-smoke.yml";

async function workflows(): Promise<{ ci: string; browser: string; process: string }> {
  const [ci, browser, process] = await Promise.all([
    readFile(CI_WORKFLOW, "utf8"),
    readFile(BROWSER_WORKFLOW, "utf8"),
    readFile(PROCESS_WORKFLOW, "utf8"),
  ]);
  return { ci, browser, process };
}

describe("GitHub Actions packaging gates", () => {
  it("keeps reusable workflow concurrency separate from its caller", async () => {
    const { ci, browser, process } = await workflows();

    expect(ci).toContain("group: ci-wrapper-${{ github.ref }}");
    expect(browser).toContain("group: browser-session-${{ github.ref }}");
    expect(process).toContain("group: process-supervision-${{ github.ref }}");
    expect(browser).not.toContain("group: ${{ github.workflow }}-${{ github.ref }}");
  });

  it("pins and verifies the exact pull-request head in every process job", async () => {
    const { process } = await workflows();
    const checkouts = process.match(/uses: actions\/checkout@/gu) ?? [];
    const exactCheckouts =
      process.match(
        /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/gu,
      ) ?? [];
    const revisionAssertions = process.match(/- name: Verify exact source revision/gu) ?? [];

    expect(checkouts).toHaveLength(2);
    expect(exactCheckouts).toHaveLength(checkouts.length);
    expect(revisionAssertions).toHaveLength(checkouts.length);
    expect(process.match(/VIDCOM_EXPECTED_GIT_SHA:/gu)).toHaveLength(checkouts.length);
  });

  it("keeps browser-only coverage runnable for every pull request", async () => {
    const { ci, browser } = await workflows();

    expect(browser).toContain("pull_request:");
    expect(browser).not.toContain("github.head_ref");
    expect(browser).toContain("npm run test:browser-session");
    expect(browser).toContain('VIDCOM_REQUIRE_BROWSER: "1"');
    expect(ci).toContain(
      "npm run test -- --exclude tests/adapter/remote-asset-browser.test.ts",
    );
  });

  it("reruns process supervision when dependency or test configuration changes", async () => {
    const { process } = await workflows();

    for (const path of [
      "package.json",
      "bun.lock",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
      "packages/*/package.json",
      "packages/*/tsconfig.json",
    ]) {
      expect(process).toContain(`- "${path}"`);
    }
  });

  it("fails Windows media setup in the install step itself", async () => {
    const { ci, process } = await workflows();

    for (const workflow of [ci, process]) {
      expect(workflow).toContain("choco install ffmpeg --no-progress --yes");
      expect(workflow).toContain("if ($LASTEXITCODE -ne 0)");
      expect(workflow).toContain("Get-Command ffmpeg -ErrorAction Stop");
      expect(workflow).toContain("Get-Command ffprobe -ErrorAction Stop");
    }
  });

  it("binds packaged-smoke evidence to the exact checked-out revision", async () => {
    const workflow = await readFile(PACKAGED_SMOKE_WORKFLOW, "utf8");

    expect(workflow).toContain("- name: Verify exact source revision");
    expect(workflow).toContain(
      "VIDCOM_EXPECTED_GIT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}",
    );
    expect(workflow).toContain("- name: Validate complete release evidence");
    expect(workflow).toContain("scripts/packaged-smoke/verify-evidence-bundle.mjs");
    expect(workflow).toContain("VIDCOM_SMOKE_EXPECTED_COMMIT:");
    for (const evidence of [
      "packaged-smoke-${{ matrix.tag }}.json",
      "doctor-report.json",
      "ffprobe.json",
      "platform.json",
      "artifact-manifest.json",
      "SHA256SUMS",
    ]) {
      expect(workflow).toContain(evidence);
    }
  });
});
