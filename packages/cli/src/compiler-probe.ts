import { fileURLToPath } from "node:url";

import type { CompilerProbeObservation } from "@vidcom/adapter/compiler-guard";
import type { ProcessSupervisorPort } from "@vidcom/core";

import { COMPILER_PROBE_SENTINEL, COMPILER_PROBE_SUCCESS } from "./compiler-probe-protocol";

function runningAsSea(): boolean {
  const sea: unknown = process.getBuiltinModule?.("node:sea");
  if (!sea || typeof sea !== "object" || !("isSea" in sea) || typeof sea.isSea !== "function") return false;
  return sea.isSea() === true;
}

/** Returns argv for re-entering this CLI as the hidden compiler child. */
export function compilerProbeCommand(
  isSea: boolean = runningAsSea(),
  sourceLauncher?: string,
): readonly string[] {
  if (isSea) return [process.execPath, COMPILER_PROBE_SENTINEL];
  const launcher = sourceLauncher ?? fileURLToPath(new URL("../bin/vidcom.mjs", import.meta.url));
  return [process.execPath, launcher, COMPILER_PROBE_SENTINEL];
}

/**
 * Runs the compiler child under the process supervisor's kill-and-verify
 * deadline and accepts only its exact post-transform marker.
 */
export async function runCompilerProbeProcess(input: {
  supervisor: ProcessSupervisorPort;
  command: readonly string[];
  environment: Record<string, string>;
  timeoutMs: number;
}): Promise<CompilerProbeObservation> {
  const result = await input.supervisor.run({
    command: input.command,
    environment: input.environment,
    timeoutMs: input.timeoutMs,
  });
  if (result.status === "terminated") {
    return {
      ok: false,
      timedOut: result.proof.reason === "timeout",
      detail: result.proof.exhaustive
        ? "the compiler child was terminated"
        : "the compiler child was terminated but process cleanup could not be proven exhaustive",
    };
  }
  const detail = result.output.stderr.trim();
  if (result.output.exitCode !== 0) {
    return {
      ok: false,
      timedOut: result.output.timedOut,
      detail: detail || `the compiler child exited ${String(result.output.exitCode)}`,
    };
  }
  if (result.output.stdout.trim() !== COMPILER_PROBE_SUCCESS) {
    return {
      ok: false,
      timedOut: false,
      detail: "the compiler child exited without its transform marker",
    };
  }
  return { ok: true, timedOut: false, detail: "compiler transform completed" };
}
