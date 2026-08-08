import path from "node:path";

import { ErrorCode } from "@vidcom/contracts";
import { err, ok, type Result } from "@vidcom/core";

export const ESBUILD_BINARY_PATH = "ESBUILD_BINARY_PATH";
export const ESBUILD_WORKER_THREADS = "ESBUILD_WORKER_THREADS";

export interface CompilerGuardOptions {
  /** Absolute path to the extracted esbuild binary. */
  esbuildBinaryPath: string;
  environment?: NodeJS.ProcessEnv;
}

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
 * nothing to stderr**. That is why this guard checks both up front and puts a
 * mandatory timeout around every call — a timeout that fires is a diagnosable
 * failure, a hang is not.
 */
export class CompilerGuard {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly esbuildBinaryPath: string;

  constructor(options: CompilerGuardOptions) {
    this.esbuildBinaryPath = options.esbuildBinaryPath;
    this.environment = options.environment ?? process.env;
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
    if (!binary || !path.isAbsolute(binary)) unmet.push(ESBUILD_BINARY_PATH);
    if (this.environment[ESBUILD_WORKER_THREADS] !== "0") unmet.push(ESBUILD_WORKER_THREADS);
    return unmet;
  }

  /**
   * Runs one compiler operation under a required timeout.
   *
   * The preflight comes first so a misconfigured environment is reported
   * immediately rather than after the caller has waited out the whole budget.
   */
  async run<T>(operation: () => Promise<T> | T, timeoutMs: number): Promise<Result<T, CompilerFailure>> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("compiler timeout must be a positive safe integer");
    }
    const unmet = this.unmetRequirements();
    if (unmet.length > 0) {
      return err({
        code: ErrorCode.CompilerUnavailable,
        message: `the compiler environment is incomplete: ${unmet.join(", ")}`,
        details: { unmet: [...unmet] },
      });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { resolve("timeout"); }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(operation).then((value) => ({ value })),
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
}
