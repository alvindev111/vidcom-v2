import path from "node:path";

import { ErrorCode } from "@vidcom/contracts";
import { err, ok, type Result } from "@vidcom/core";

export const ESBUILD_BINARY_PATH = "ESBUILD_BINARY_PATH";
export const ESBUILD_WORKER_THREADS = "ESBUILD_WORKER_THREADS";

export interface CompilerGuardOptions {
  /** Absolute path to the extracted esbuild binary. */
  esbuildBinaryPath: string;
  environment?: NodeJS.ProcessEnv;
  /** Runs the real transform in a separately killable process. */
  probeRunner?: CompilerProbeRunner;
}

/** Process observation returned after a supervised compiler probe settles. */
export interface CompilerProbeObservation {
  ok: boolean;
  timedOut: boolean;
  detail?: string;
}

/** Executes a compiler probe with an operating-system-enforced deadline. */
export type CompilerProbeRunner = (timeoutMs: number) => Promise<CompilerProbeObservation>;

export interface CompilerFailure {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Makes in-process compiler work fail loudly instead of hanging.
 *
 * Two environment variables decide whether esbuild can run inside a packaged
 * binary at all. `ESBUILD_BINARY_PATH` names the extracted executable, because
 * there is no `node_modules` to find it in. `ESBUILD_WORKER_THREADS=0` stops it
 * spawning a worker that a single-file binary cannot re-enter.
 *
 * Missing either one does not raise: the call **hangs forever and writes
 * nothing to stderr**. The guard therefore checks both up front. Synchronous
 * compiler work is never placed under a JavaScript timer: a blocked event loop
 * cannot observe that timer, so the real probe runs in a supervised child that
 * can be killed by the parent.
 */
export class CompilerGuard {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly esbuildBinaryPath: string;
  private readonly probeRunner: CompilerProbeRunner | undefined;

  constructor(options: CompilerGuardOptions) {
    this.esbuildBinaryPath = options.esbuildBinaryPath;
    this.environment = options.environment ?? process.env;
    this.probeRunner = options.probeRunner;
  }

  /** Applies both variables. Production calls this once at boot. */
  configure(): void {
    this.environment[ESBUILD_BINARY_PATH] = this.esbuildBinaryPath;
    this.environment[ESBUILD_WORKER_THREADS] = "0";
  }

  /** Names every variable that is absent or unusable, in a stable order. */
  unmetRequirements(): readonly string[] {
    const unmet: string[] = [];
    const binary = this.environment[ESBUILD_BINARY_PATH];
    if (
      !binary
      || !path.isAbsolute(binary)
      || path.resolve(binary) !== path.resolve(this.esbuildBinaryPath)
    ) unmet.push(ESBUILD_BINARY_PATH);
    if (this.environment[ESBUILD_WORKER_THREADS] !== "0") unmet.push(ESBUILD_WORKER_THREADS);
    return unmet;
  }

  /** Runs a real compiler transform in the injected, killable process boundary. */
  async probe(timeoutMs: number): Promise<Result<string, CompilerFailure>> {
    this.assertTimeout(timeoutMs);
    const unmet = this.unmetRequirements();
    if (unmet.length > 0) return this.unavailableEnvironment(unmet);
    if (!this.probeRunner) {
      return err({
        code: ErrorCode.CompilerUnavailable,
        message: "the compiler probe runner is unavailable",
      });
    }
    try {
      const observation = await this.probeRunner(timeoutMs);
      if (observation.timedOut) {
        return err({
          code: ErrorCode.CompilerUnavailable,
          message: `the compiler did not answer within ${timeoutMs}ms`,
          details: { timeoutMs },
        });
      }
      if (!observation.ok) {
        return err({
          code: ErrorCode.CompilerUnavailable,
          message: observation.detail ?? "the compiler probe failed",
        });
      }
      return ok(observation.detail ?? "compiler transform completed");
    } catch (error) {
      return err({
        code: ErrorCode.CompilerUnavailable,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Runs one asynchronous compiler operation under a required timeout.
   *
   * The preflight comes first so a misconfigured environment is reported
   * immediately rather than after the caller has waited out the whole budget.
   * Synchronous APIs such as `transformSync` are deliberately excluded: they
   * must run through `probe()` or another supervised process boundary.
   */
  async run<T>(operation: () => Promise<T>, timeoutMs: number): Promise<Result<T, CompilerFailure>> {
    this.assertTimeout(timeoutMs);
    const unmet = this.unmetRequirements();
    if (unmet.length > 0) return this.unavailableEnvironment(unmet);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { resolve("timeout"); }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        operation().then((value) => ({ value })),
        expiry,
      ]);
      if (outcome === "timeout") {
        return err({
          code: ErrorCode.CompilerUnavailable,
          message: `the compiler did not answer within ${timeoutMs}ms`,
          details: { timeoutMs },
        });
      }
      return ok(outcome.value);
    } catch (error) {
      return err({
        code: ErrorCode.CompilerUnavailable,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private assertTimeout(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("compiler timeout must be a positive safe integer");
    }
  }

  private unavailableEnvironment(unmet: readonly string[]): Result<never, CompilerFailure> {
    return err({
      code: ErrorCode.CompilerUnavailable,
      message: `the compiler environment is incomplete: ${unmet.join(", ")}`,
      details: { unmet: [...unmet] },
    });
  }
}
