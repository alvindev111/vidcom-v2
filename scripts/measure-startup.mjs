import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const BASELINE_DIRECTORY = path.join(REPOSITORY_ROOT, ".github", "perf-baseline");

/**
 * Hard ceilings from Design §9.1, in milliseconds.
 *
 * These are catastrophic absolute bounds independent of the statistical
 * regression gate below. They are per runner because a Windows runner spends
 * most of a cold start being scanned by antivirus, and holding it to a macOS
 * number would fail a machine that is behaving normally.
 */
export const STARTUP_CEILINGS = {
  "darwin-arm64": { coldServe: 120_000, warmServe: 10_000, warmApp: 2_000 },
  "linux-x64": { coldServe: 120_000, warmServe: 11_000, warmApp: 2_000 },
  "win32-x64": { coldServe: 180_000, warmServe: 20_000, warmApp: 3_000 },
};

/**
 * How far above its own baseline a runner may drift before it fails.
 *
 * One input to the independent statistical gate: a sustained 50% median drift
 * is worth hearing about even while it sits comfortably under the ceiling.
 */
export const REGRESSION_FACTOR = 1.5;
export const MEASUREMENT_QUANTUM_MS = 200;
export const MIN_BASELINE_SAMPLES = 5;
export const STARTUP_BASELINE_COHORT = "double-deep-integrity-v1";
const GITHUB_ACTIONS_EVIDENCE_PATTERN = /^github-actions:[1-9]\d*\/[1-9]\d*$/u;

export function runnerLabel(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function baselinePath(label) {
  return path.join(BASELINE_DIRECTORY, `${label}.json`);
}

export function isStartupBaseline(label, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "cohort,runner,samples,version") return false;
  if (
    value.version !== 2
    || value.runner !== label
    || value.cohort !== STARTUP_BASELINE_COHORT
    || !Array.isArray(value.samples)
  ) return false;
  if (value.samples.length < MIN_BASELINE_SAMPLES) return false;
  const evidence = new Set();
  for (const sample of value.samples) {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) return false;
    if (Object.keys(sample).sort().join(",") !== "commit,evidence,measurements") return false;
    if (
      typeof sample.evidence !== "string"
      || sample.evidence.length === 0
      || sample.evidence.length > 200
      || !GITHUB_ACTIONS_EVIDENCE_PATTERN.test(sample.evidence)
      || evidence.has(sample.evidence)
    ) return false;
    evidence.add(sample.evidence);
    if (typeof sample.commit !== "string" || !/^[0-9a-f]{40}$/u.test(sample.commit)) return false;
    const measurements = sample.measurements;
    if (!measurements || typeof measurements !== "object" || Array.isArray(measurements)) return false;
    if (Object.keys(measurements).sort().join(",") !== "coldServe,warmServe") return false;
    for (const [name, measurement] of Object.entries(measurements)) {
      const ceiling = STARTUP_CEILINGS[label]?.[name];
      if (
        !Number.isSafeInteger(measurement)
        || measurement < 0
        || typeof ceiling !== "number"
        || measurement > ceiling
      ) return false;
    }
  }
  return true;
}

export async function readBaseline(label) {
  const file = baselinePath(label);
  if (!existsSync(file)) return null;
  try {
    const baseline = JSON.parse(await readFile(file, "utf8"));
    return isStartupBaseline(label, baseline) ? baseline : null;
  } catch {
    // The packaged smoke treats null as a hard failure now that all three
    // runner baselines are committed. recordBaseline still uses null for the
    // explicit first-capture workflow.
    return null;
  }
}

/**
 * Writes a complete reviewed sample set only when there is no baseline.
 *
 * Overwriting on every run would make the regression gate meaningless: each
 * measurement would become its own baseline and nothing could ever drift.
 * Changing one is a threshold change, and those go through a pull request.
 */
export async function recordBaseline(label, samples) {
  const file = baselinePath(label);
  const existing = await readBaseline(label);
  if (existing !== null) return { written: false, baseline: existing };
  if (existsSync(file)) {
    throw new Error(`existing startup baseline is invalid for ${label}`);
  }
  await mkdir(BASELINE_DIRECTORY, { recursive: true });
  const baseline = { version: 2, runner: label, cohort: STARTUP_BASELINE_COHORT, samples };
  if (!isStartupBaseline(label, baseline)) throw new Error(`invalid startup baseline for ${label}`);
  await writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return { written: true, baseline };
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function medianStartupMeasurements(samples) {
  if (!Array.isArray(samples) || samples.length < 3 || samples.length % 2 === 0) return null;
  const names = ["coldServe", "warmServe"];
  if (samples.some((sample) => (
    !sample || typeof sample !== "object" || Array.isArray(sample)
    || Object.keys(sample).sort().join(",") !== names.slice().sort().join(",")
    || names.some((name) => !Number.isSafeInteger(sample[name]) || sample[name] < 0)
  ))) return null;
  return Object.fromEntries(names.map((name) => [
    name,
    median(samples.map((sample) => sample[name]).sort((left, right) => left - right)),
  ]));
}

export function shouldConfirmStartup(results) {
  const failures = failingResults(results);
  return failures.length > 0 && failures.every((result) => result.status === "regressed");
}

export function startupBaselineStatistics(label, baseline, name) {
  if (!isStartupBaseline(label, baseline) || (name !== "coldServe" && name !== "warmServe")) return null;
  const values = baseline.samples
    .map((sample) => sample?.measurements?.[name])
    .sort((left, right) => left - right);
  const center = median(values);
  const upper = values[Math.ceil(values.length * 0.95) - 1];
  return {
    center,
    upper,
    limit: Math.max(center * REGRESSION_FACTOR, upper + MEASUREMENT_QUANTUM_MS),
  };
}

/**
 * Judges one run against both independent gates.
 *
 * The ceiling catches catastrophic starts; the baseline catches sustained
 * drift that still sits below that absolute bound. Either gate blocks. A
 * measurement missing from either side is reported rather than assumed fine.
 */
export function evaluateStartup(label, measurements, baseline) {
  const ceilings = STARTUP_CEILINGS[label];
  if (!ceilings) return [{ name: "runner", status: "unknown", detail: `no ceilings for ${label}` }];
  if (!isStartupBaseline(label, baseline)) {
    return [{ name: "baseline", status: "invalid", detail: `startup baseline is invalid for ${label}` }];
  }
  if (
    !measurements
    || typeof measurements !== "object"
    || Array.isArray(measurements)
    || Object.keys(measurements).sort().join(",") !== "coldServe,warmServe"
  ) {
    return [{
      name: "measurements",
      status: "invalid",
      detail: "startup measurements must contain exactly coldServe and warmServe",
    }];
  }

  const results = [];
  for (const [name, value] of Object.entries(measurements)) {
    const ceiling = ceilings[name];
    if (ceiling === undefined) {
      results.push({ name, status: "unknown", detail: "no ceiling is defined for this measurement" });
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      results.push({ name, status: "invalid", detail: "measurement must be a non-negative safe integer" });
      continue;
    }
    if (value > ceiling) {
      results.push({ name, status: "over-ceiling", value, limit: ceiling });
      continue;
    }
    const statistics = startupBaselineStatistics(label, baseline, name);
    if (statistics && value > statistics.limit) {
      results.push({ name, status: "regressed", value, limit: statistics.limit });
      continue;
    }
    results.push({ name, status: "ok", value, limit: Math.min(ceiling, statistics?.limit ?? ceiling) });
  }
  return results;
}

export function failingResults(results) {
  return results.filter((result) => (
    result.status === "over-ceiling"
    || result.status === "regressed"
    || result.status === "invalid"
  ));
}
