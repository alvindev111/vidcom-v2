import {
  REGRESSION_FACTOR,
  STARTUP_CEILINGS,
  evaluateStartup,
  failingResults,
  runnerLabel,
} from "../../scripts/measure-startup.mjs";
import { describe, expect, it } from "vitest";

const LABEL = "darwin-arm64";

describe("startup ceilings", () => {
  it("covers every runner the artifact is built on", () => {
    expect(Object.keys(STARTUP_CEILINGS).sort()).toEqual([
      "darwin-arm64",
      "linux-x64",
      "win32-x64",
    ]);
  });

  it("gives Windows more room for a cold start", () => {
    // Most of a cold start there is spent being scanned: the Python stack alone
    // is around half a gigabyte on disk. Holding it to the macOS number would
    // fail a machine that is behaving normally.
    expect(STARTUP_CEILINGS["win32-x64"]!.coldServe)
      .toBeGreaterThan(STARTUP_CEILINGS["darwin-arm64"]!.coldServe);
  });

  it("names this runner the way the baseline file does", () => {
    expect(runnerLabel("win32", "x64")).toBe("win32-x64");
  });
});

describe("startup gates", () => {
  it("passes a run inside both limits", () => {
    const results = evaluateStartup(LABEL, { warmServe: 900 }, {
      measurements: { warmServe: 800 },
    });
    expect(failingResults(results)).toEqual([]);
  });

  it("fails a run over the ceiling", () => {
    // The only number that blocks a release.
    const results = evaluateStartup(LABEL, { warmServe: 5_000 }, null);
    expect(failingResults(results)[0]).toMatchObject({ status: "over-ceiling" });
  });

  it("fails a run that doubled against its own baseline", () => {
    // Independent of the ceiling: a start-up that doubled is worth hearing
    // about even while it still fits.
    const results = evaluateStartup(LABEL, { warmServe: 1_800 }, {
      measurements: { warmServe: 1_000 },
    });
    expect(failingResults(results)[0]).toMatchObject({ status: "regressed" });
    expect(REGRESSION_FACTOR).toBe(1.5);
  });

  it("says so rather than passing a measurement it has no limit for", () => {
    const results = evaluateStartup(LABEL, { somethingNew: 1 }, null);
    expect(results[0]?.status).toBe("unknown");
    // Unknown is not a failure — it is a gap, and the report names it instead
    // of quietly counting it as fine.
    expect(failingResults(results)).toEqual([]);
  });

  it("says so rather than guessing on a runner it does not know", () => {
    expect(evaluateStartup("freebsd-riscv", { warmServe: 1 }, null)[0]?.status).toBe("unknown");
  });
});
