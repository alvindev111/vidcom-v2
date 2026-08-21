/**
 * The packaged smoke, one entry per step of Design §11.4.
 *
 * The list is data rather than a script so `--step` and `--from` mean something
 * exact, and so a skipped step is a value somebody can assert on. The phase's
 * acceptance criterion is "no required step was skipped", and a criterion that
 * can only be checked by reading a log is one nobody checks.
 */
export const SMOKE_STEPS = [
  { id: "build", required: true, title: "build the artifact and its checksum" },
  { id: "clean-environment", required: true, title: "clean HOME, app-data and workspace; no Node or Python on PATH" },
  { id: "restore-caches", required: true, title: "restore the browser and model caches, leaving app-data runtime empty" },
  { id: "identify", required: true, title: "version, cold doctor --repair, warm doctor --deep" },
  { id: "ui-lifecycle", required: true, title: "start, exchange the nonce, activate a workspace, create a project" },
  { id: "import", required: true, title: "import a fixture from outside the workspace" },
  { id: "bridge", required: true, title: "MCP bridge beside a live UI daemon, across a restart" },
  { id: "render-media", required: true, title: "TTS, snapshot and render, verified with ffprobe" },
  { id: "upload-and-progress", required: true, title: "20 MB upload and SSE progress through the packaged host" },
  { id: "render-cli", required: true, title: "render wait, detach, and cancel mid-render" },
  { id: "offline", required: true, title: "warm render and TTS with the network cut at the runner" },
  { id: "lease-loss", required: true, title: "lease loss: writes refused, discovery gone, both degrade paths" },
  {
    id: "editing-experience-runtime",
    required: true,
    title: "bundled catalog listed and installed from the artifact across two boots, offline",
  },
  { id: "provenance", required: true, title: "artifact vicinity, app-data boundary, checksum and provenance" },
];

export function stepIds() {
  return SMOKE_STEPS.map((step) => step.id);
}

/**
 * Chooses which steps run.
 *
 * `--step` is one step, `--from` is everything from there on. Both exist so a
 * failing step can be worked on without re-running the eleven before it, which
 * is the difference between a smoke somebody fixes and one they stop touching.
 */
export function selectSteps(options = {}) {
  if (options.step !== undefined) {
    const found = SMOKE_STEPS.filter((step) => step.id === options.step);
    if (found.length === 0) throw new Error(`unknown smoke step: ${options.step}`);
    return found;
  }
  if (options.from !== undefined) {
    const index = SMOKE_STEPS.findIndex((step) => step.id === options.from);
    if (index === -1) throw new Error(`unknown smoke step: ${options.from}`);
    return SMOKE_STEPS.slice(index);
  }
  return [...SMOKE_STEPS];
}

/**
 * The exit code for one run.
 *
 * A skipped required step is a pass by default and a failure under strict,
 * which is what the packaged smoke job sets. R8.4 says a missing required
 * component fails the job rather than skipping it; outside the job, a skip
 * still means "not reached yet".
 */
export function smokeExitCode(results, options = {}) {
  const bad = results.filter((result) => result.status === "failed"
    || (options.strict === true && result.required && result.status === "skipped"));
  return bad.length === 0 ? 0 : 1;
}

export function failedStepIds(results, options = {}) {
  return results
    .filter((result) => result.status === "failed"
      || (options.strict === true && result.required && result.status === "skipped"))
    .map((result) => result.id);
}

export function parseSmokeArgs(argv) {
  const options = { strict: process.env.VIDCOM_DOCTOR_STRICT === "1" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--strict") {
      options.strict = true;
      continue;
    }
    if (flag !== "--step" && flag !== "--from") throw new Error(`unknown smoke argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a step id`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (options.step !== undefined && options.from !== undefined) {
    throw new Error("--step and --from cannot be combined");
  }
  return options;
}
