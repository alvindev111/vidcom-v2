import {
  MEASUREMENT_QUANTUM_MS,
  MIN_BASELINE_SAMPLES,
  REGRESSION_FACTOR,
  STARTUP_BASELINE_COHORT,
  STARTUP_CEILINGS,
  evaluateStartup,
  failingResults,
  isStartupBaseline,
  readBaseline,
  runnerLabel,
  startupBaselineStatistics,
} from "../../scripts/measure-startup.mjs";
import { describe, expect, it } from "vitest";

const LABEL = "darwin-arm64";
function baseline(values: number[]) {
  return {
    version: 2,
    runner: LABEL,
    cohort: STARTUP_BASELINE_COHORT,
    samples: values.map((warmServe, index) => ({
      evidence: `github-actions:${index + 1}/${index + 1}`,
      commit: String(index + 1).padStart(40, "0"),
      measurements: { coldServe: warmServe + 200, warmServe },
    })),
  };
}

function candidate(warmServe: number) {
  return { coldServe: warmServe + 200, warmServe };
}

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

  it("accepts only a complete five-sample baseline for the named runner", () => {
    expect(MIN_BASELINE_SAMPLES).toBe(5);
    const valid = baseline([800, 810, 820, 830, 840]);
    expect(isStartupBaseline(LABEL, valid)).toBe(true);
    expect(isStartupBaseline("linux-x64", valid)).toBe(false);
    expect(isStartupBaseline(LABEL, { ...valid, cohort: "different-topology" })).toBe(false);
    expect(isStartupBaseline(LABEL, {
      ...valid,
      samples: valid.samples.slice(1),
    })).toBe(false);
    expect(isStartupBaseline(LABEL, {
      ...valid,
      samples: valid.samples.map((sample, index) => index === 0
        ? { ...sample, measurements: { ...sample.measurements, extra: 1 } }
        : sample),
    })).toBe(false);
    expect(isStartupBaseline(LABEL, {
      ...valid,
      samples: valid.samples.map((sample, index) => index === 1
        ? { ...sample, evidence: valid.samples[0].evidence }
        : sample),
    })).toBe(false);
    expect(isStartupBaseline(LABEL, {
      ...valid,
      samples: valid.samples.map((sample, index) => index === 2
        ? { ...sample, measurements: { ...sample.measurements, warmServe: 1.5 } }
        : sample),
    })).toBe(false);
    expect(isStartupBaseline(LABEL, { ...valid, derivedLimit: 1_000 })).toBe(false);
    expect(isStartupBaseline(LABEL, {
      ...valid,
      samples: valid.samples.map((sample, index) => index === 3
        ? { ...sample, measurements: { ...sample.measurements, warmServe: Number.MAX_VALUE } }
        : sample),
    })).toBe(false);
  });

  it("loads a complete committed baseline for every native runner", async () => {
    for (const label of Object.keys(STARTUP_CEILINGS)) {
      await expect(readBaseline(label)).resolves.toMatchObject({
        version: 2,
        runner: label,
      });
    }
  });

  it("keeps each hard ceiling independently above its statistical regression gate", async () => {
    for (const [label, ceilings] of Object.entries(STARTUP_CEILINGS)) {
      const committed = await readBaseline(label);
      expect(committed).not.toBeNull();
      for (const name of ["coldServe", "warmServe"] as const) {
        const statistics = startupBaselineStatistics(label, committed, name);
        expect(statistics).not.toBeNull();
        expect(ceilings[name]).toBeGreaterThanOrEqual(
          statistics!.limit + MEASUREMENT_QUANTUM_MS,
        );
      }
    }
  });
});

describe("startup gates", () => {
  it("passes a run inside both limits", () => {
    const results = evaluateStartup(LABEL, candidate(900), baseline([800, 810, 820, 830, 840]));
    expect(failingResults(results)).toEqual([]);
  });

  it("fails a run over the ceiling", () => {
    const results = evaluateStartup(LABEL, {
      coldServe: 1_000,
      warmServe: STARTUP_CEILINGS[LABEL].warmServe + 1,
    }, baseline([800, 810, 820, 830, 840]));
    expect(failingResults(results)[0]).toMatchObject({ status: "over-ceiling" });
  });

  it("derives deterministic median and nearest-rank p95 statistics", () => {
    expect(startupBaselineStatistics(LABEL, baseline([100, 200, 300, 400, 500]), "warmServe"))
      .toEqual({ center: 300, upper: 500, limit: 700 });
    expect(startupBaselineStatistics(LABEL, baseline([100, 200, 300, 400, 500, 600]), "warmServe"))
      .toEqual({ center: 350, upper: 600, limit: 800 });
  });

  it("uses the larger of 1.5x median and p95 plus measurement quantum", () => {
    expect(startupBaselineStatistics(
      LABEL,
      baseline([1_000, 1_000, 1_000, 1_000, 1_100]),
      "warmServe",
    )?.limit)
      .toBe(1_500);
    expect(startupBaselineStatistics(
      LABEL,
      baseline([1_000, 1_000, 1_000, 1_000, 1_400]),
      "warmServe",
    )?.limit)
      .toBe(1_600);
  });

  it("passes at the statistical limit and fails one millisecond above it", () => {
    const committed = baseline([1_000, 1_000, 1_000, 1_000, 1_100]);
    expect(failingResults(evaluateStartup(LABEL, candidate(1_500), committed))).toEqual([]);
    const results = evaluateStartup(LABEL, candidate(1_501), committed);
    expect(failingResults(results)[0]).toMatchObject({ status: "regressed" });
    expect(REGRESSION_FACTOR).toBe(1.5);
  });

  it("fails closed on invalid candidate measurements or baseline authority", () => {
    const committed = baseline([1_000, 1_000, 1_000, 1_000, 1_100]);
    expect(failingResults(evaluateStartup(LABEL, candidate(-1), committed))[0])
      .toMatchObject({ status: "invalid" });
    expect(failingResults(evaluateStartup(LABEL, candidate(Number.NaN), committed))[0])
      .toMatchObject({ status: "invalid" });
    expect(startupBaselineStatistics(
      LABEL,
      { ...committed, runner: "linux-x64" },
      "warmServe",
    )).toBeNull();
    expect(failingResults(evaluateStartup(
      LABEL,
      candidate(1_000),
      { ...committed, runner: "linux-x64" },
    ))[0]).toMatchObject({ name: "baseline", status: "invalid" });
  });

  it("fails closed on missing or extra candidate measurements", () => {
    const committed = baseline([800, 810, 820, 830, 840]);
    for (const measurements of [{}, { coldServe: 1 }, { warmServe: 1 }, {
      coldServe: 1,
      warmServe: 1,
      somethingNew: 1,
    }]) {
      expect(failingResults(evaluateStartup(LABEL, measurements, committed))[0])
        .toMatchObject({ name: "measurements", status: "invalid" });
    }
  });

  it("says so rather than guessing on a runner it does not know", () => {
    expect(evaluateStartup("freebsd-riscv", { warmServe: 1 }, null)[0]?.status).toBe("unknown");
  });
});
