import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactPath } from "../build-sea.mjs";
import { hostPlatformTag } from "../stage-artifact-runtime.mjs";
import { STEP_BODIES } from "./bodies.mjs";
import { createSmokeRoot } from "./environment.mjs";
import { completeSmokeEvidence } from "./evidence.mjs";
import {
  failedStepIds,
  parseSmokeArgs,
  selectSteps,
  smokeExitCode,
} from "./steps.mjs";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Why a step could not run, when it could not.
 *
 * Named rather than swallowed: every step below drives the packaged executable,
 * and the executable needs its runtime extracted. Saying so is the difference
 * between a smoke that is honestly incomplete and one that looks green.
 */
function blockedReason() {
  // `hostPlatformTag()` resolves platform *and* architecture. The build's own
  // table is keyed by both, so indexing it with the platform alone yields an
  // object that reads as a tag right up until something tries to use it.
  let tag;
  try {
    tag = hostPlatformTag();
  } catch {
    return `there is no artifact for ${process.platform}-${process.arch}`;
  }
  const artifact = artifactPath(tag);
  if (!existsSync(artifact)) {
    return `no artifact at ${path.relative(REPOSITORY_ROOT, artifact)}; run \`bun run build:artifact\``;
  }
  return null;
}

function hostArtifactTag() {
  try {
    return hostPlatformTag();
  } catch {
    return `${process.platform}-${process.arch}`;
  }
}

async function runStep(step, context) {
  const startedAt = Date.now();
  const blocked = blockedReason();
  if (blocked !== null) {
    return {
      id: step.id,
      required: step.required,
      status: "skipped",
      durationMs: Date.now() - startedAt,
      detail: blocked,
    };
  }

  const body = STEP_BODIES[step.id];
  if (!body) {
    return {
      id: step.id,
      required: step.required,
      status: "skipped",
      durationMs: Date.now() - startedAt,
      detail: "this step has no body yet",
    };
  }

  try {
    const detail = await body(context);
    return { id: step.id, required: step.required, status: "passed", durationMs: Date.now() - startedAt, detail };
  } catch (error) {
    // Failed, never skipped. A step whose body threw was reached and did not do
    // what it claims to do, and those two outcomes need opposite responses.
    return {
      id: step.id,
      required: step.required,
      status: "failed",
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(argv) {
  const options = parseSmokeArgs(argv);
  const results = [];
  const tag = hostArtifactTag();
  // One environment for the whole run: the steps build on each other, and a
  // fresh HOME per step would make "cold" and "warm" the same measurement.
  const smoke = blockedReason() === null ? await createSmokeRoot() : null;
  const context = smoke === null ? null : {
    ...smoke,
    artifact: artifactPath(tag),
    measurements: {},
  };
  for (const step of selectSteps(options)) {
    const result = await runStep(step, context);
    results.push(result);
    // Progress on stderr so stdout stays clean for the evidence document.
    process.stderr.write(
      `${result.status.padEnd(7)} ${result.id} ${String(result.durationMs)}ms`
      + `${result.detail === undefined ? "" : ` — ${result.detail}`}\n`,
    );
  }

  const failed = failedStepIds(results, options);
  const isCompleteRun = options.step === undefined && options.from === undefined;
  const allPassed = results.every((result) => result.status === "passed");
  // Held rather than thrown, so a run that finished thirteen steps still
  // reports them. The reason is written into the report and the run still ends
  // non-zero — what it must not do is take the report down with it.
  let evidenceError = null;
  if (isCompleteRun && allPassed && failed.length === 0) {
    try {
      const evidence = completeSmokeEvidence(tag, context);
      const evidenceDirectory = process.env.VIDCOM_SMOKE_EVIDENCE_DIR;
      if (process.env.VIDCOM_SMOKE_RELEASE === "1" && !evidenceDirectory) {
        throw new Error("a successful release smoke requires VIDCOM_SMOKE_EVIDENCE_DIR");
      }
      if (evidenceDirectory) {
        await mkdir(evidenceDirectory, { recursive: true });
        await Promise.all([
          writeFile(path.join(evidenceDirectory, "doctor-report.json"), `${JSON.stringify(evidence.doctor, null, 2)}\n`),
          writeFile(path.join(evidenceDirectory, "ffprobe.json"), `${JSON.stringify(evidence.ffprobe, null, 2)}\n`),
          writeFile(path.join(evidenceDirectory, "platform.json"), `${JSON.stringify(evidence.platform, null, 2)}\n`),
        ]);
      }
    } catch (error) {
      evidenceError = error instanceof Error ? error.message : String(error);
    }
  }

  // Torn down after the evidence is on disk, never before. Persisting the
  // caches is an optimisation for the next run, and it once threw — which
  // discarded the report for thirteen steps that had already finished.
  const cacheWriteBack = (await smoke?.dispose()) ?? [];

  process.stdout.write(`${JSON.stringify({
    version: 1,
    platform: tag,
    strict: options.strict === true,
    measurements: context?.measurements ?? {},
    steps: results,
    cacheWriteBack,
    evidenceError,
  }, null, 2)}\n`);

  for (const failure of cacheWriteBack) {
    process.stderr.write(`packaged-smoke: cache write-back skipped ${failure.entry}: ${failure.reason}\n`);
  }

  if (failed.length > 0) {
    // Named, never just "smoke failed": thirteen steps and one message is a
    // report somebody has to reproduce locally to understand.
    process.stderr.write(`packaged-smoke: failed at ${failed.join(", ")}\n`);
  }
  if (evidenceError !== null) {
    process.stderr.write(`packaged-smoke: evidence was not written: ${evidenceError}\n`);
  }
  process.exitCode = evidenceError === null ? smokeExitCode(results, options) : 1;
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`packaged-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
