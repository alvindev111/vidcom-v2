import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const BASELINE_DIRECTORY = path.join(REPOSITORY_ROOT, ".github", "perf-baseline");

/**
 * Hard ceilings from Design §9.1, in milliseconds.
 *
 * These are the only numbers that block a release. They are per runner because
 * a Windows runner spends most of a cold start being scanned by antivirus, and
 * holding it to a macOS number would fail a machine that is behaving normally.
 */
export const STARTUP_CEILINGS = {
  "darwin-arm64": { coldServe: 120_000, warmServe: 3_000, warmApp: 2_000 },
  "linux-x64": { coldServe: 120_000, warmServe: 3_000, warmApp: 2_000 },
  "win32-x64": { coldServe: 180_000, warmServe: 5_000, warmApp: 3_000 },
};

/**
 * How far above its own baseline a runner may drift before it fails.
 *
 * A second, independent gate: a start-up that doubled is a regression worth
 * hearing about even while it sits comfortably under the ceiling.
 */
export const REGRESSION_FACTOR = 1.5;

export function runnerLabel(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function baselinePath(label) {
  return path.join(BASELINE_DIRECTORY, `${label}.json`);
}

export async function readBaseline(label) {
  const file = baselinePath(label);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    // A baseline that cannot be parsed is not a baseline. Treating it as absent
    // records a fresh one rather than failing every run until somebody notices.
    return null;
  }
}

/**
 * Writes a baseline only when there is none.
 *
 * Overwriting on every run would make the regression gate meaningless: each
 * measurement would become its own baseline and nothing could ever drift.
 * Changing one is a threshold change, and those go through a pull request.
 */
export async function recordBaseline(label, measurements) {
  const existing = await readBaseline(label);
  if (existing !== null) return { written: false, baseline: existing };
  await mkdir(BASELINE_DIRECTORY, { recursive: true });
  const baseline = { version: 1, runner: label, measurements };
  await writeFile(baselinePath(label), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return { written: true, baseline };
}

/**
 * Judges one run against both gates.
 *
 * The ceiling is what blocks a release; the baseline is what catches a change
 * that made start-up much worse without leaving the allowed range. A
 * measurement missing from either side is reported rather than assumed fine.
 */
export function evaluateStartup(label, measurements, baseline) {
  const ceilings = STARTUP_CEILINGS[label];
  if (!ceilings) return [{ name: "runner", status: "unknown", detail: `no ceilings for ${label}` }];

  const results = [];
  for (const [name, value] of Object.entries(measurements)) {
    const ceiling = ceilings[name];
    if (ceiling === undefined) {
      results.push({ name, status: "unknown", detail: "no ceiling is defined for this measurement" });
      continue;
    }
    if (value > ceiling) {
      results.push({ name, status: "over-ceiling", value, limit: ceiling });
      continue;
    }
    const previous = baseline?.measurements?.[name];
    if (typeof previous === "number" && value > previous * REGRESSION_FACTOR) {
      results.push({ name, status: "regressed", value, limit: previous * REGRESSION_FACTOR });
      continue;
    }
    results.push({ name, status: "ok", value, limit: ceiling });
  }
  return results;
}

export function failingResults(results) {
  return results.filter((result) => result.status === "over-ceiling" || result.status === "regressed");
}
