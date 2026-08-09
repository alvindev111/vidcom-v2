import path from "node:path";

import {
  CompilerGuard,
  ESBUILD_BINARY_PATH,
  ESBUILD_WORKER_THREADS,
  type CompilerProbeRunner,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

const BINARY = path.resolve("/runtime/node/bin/esbuild");

function guard(environment: Record<string, string | undefined>, probeRunner?: CompilerProbeRunner) {
  return new CompilerGuard({
    esbuildBinaryPath: BINARY,
    environment: environment as NodeJS.ProcessEnv,
    ...(probeRunner ? { probeRunner } : {}),
  });
}

function configured(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  new CompilerGuard({ esbuildBinaryPath: BINARY, environment: environment as NodeJS.ProcessEnv }).configure();
  return environment;
}

describe("compiler guard", () => {
  it("sets both variables, since either one alone still hangs", () => {
    const environment = configured();
    expect(environment[ESBUILD_BINARY_PATH]).toBe(BINARY);
    expect(environment[ESBUILD_WORKER_THREADS]).toBe("0");
    expect(guard(environment).unmetRequirements()).toEqual([]);
  });

  it.each([
    [ESBUILD_BINARY_PATH, (environment: Record<string, string | undefined>) => { delete environment[ESBUILD_BINARY_PATH]; }],
    [ESBUILD_WORKER_THREADS, (environment: Record<string, string | undefined>) => { delete environment[ESBUILD_WORKER_THREADS]; }],
  ])("reports a coded failure rather than hanging when %s is absent", async (name, remove) => {
    const environment = configured();
    remove(environment);

    const started = Date.now();
    const result = await guard(environment).run(
      // Would never settle. Without the preflight this is the exact shape of
      // the real failure: no error, no stderr, no return.
      () => new Promise<never>(() => {}),
      30_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CompilerUnavailable);
    expect(result.error.details).toEqual({ unmet: [name] });
    // Reported immediately, not after waiting out the budget.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports both when neither variable is set", async () => {
    const result = await guard({}).run(async () => "unreachable", 1_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details).toEqual({
      unmet: [ESBUILD_BINARY_PATH, ESBUILD_WORKER_THREADS],
    });
  });

  it("rejects a relative binary path, which esbuild cannot use", () => {
    expect(guard({
      [ESBUILD_BINARY_PATH]: "esbuild",
      [ESBUILD_WORKER_THREADS]: "0",
    }).unmetRequirements()).toEqual([ESBUILD_BINARY_PATH]);
  });

  it("rejects a different absolute binary instead of probing the wrong runtime", () => {
    expect(guard({
      [ESBUILD_BINARY_PATH]: path.resolve("/other-runtime/bin/esbuild"),
      [ESBUILD_WORKER_THREADS]: "0",
    }).unmetRequirements()).toEqual([ESBUILD_BINARY_PATH]);
  });

  it("rejects a worker-thread setting that is not exactly disabled", () => {
    expect(guard({
      [ESBUILD_BINARY_PATH]: BINARY,
      [ESBUILD_WORKER_THREADS]: "1",
    }).unmetRequirements()).toEqual([ESBUILD_WORKER_THREADS]);
  });

  it("times out a configured compiler that never answers", async () => {
    const started = Date.now();
    const result = await guard(configured()).run(() => new Promise<never>(() => {}), 150);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CompilerUnavailable);
    expect(result.error.details).toEqual({ timeoutMs: 150 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("returns the value when the compiler answers in time", async () => {
    const result = await guard(configured()).run(async () => "compiled", 1_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("compiled");
  });

  it("turns a thrown compiler error into the same coded failure", async () => {
    const result = await guard(configured()).run(async () => { throw new Error("esbuild exploded"); }, 1_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CompilerUnavailable);
    expect(result.error.message).toBe("esbuild exploded");
  });

  it("refuses to run without a timeout at all", async () => {
    // No compiler call may exist without one; an optional timeout would be a
    // hang waiting to be reintroduced.
    await expect(guard(configured()).run(async () => "x", 0)).rejects.toThrow(TypeError);
    await expect(guard(configured()).run(async () => "x", -1)).rejects.toThrow(TypeError);
  });

  it("passes the mandatory timeout into a separately supervised probe", async () => {
    const seen: number[] = [];
    const result = await guard(configured(), async (timeoutMs) => {
      seen.push(timeoutMs);
      return { ok: true, timedOut: false, detail: "compiler transform completed" };
    }).probe(2_000);

    expect(seen).toEqual([2_000]);
    expect(result).toEqual({ ok: true, value: "compiler transform completed" });
  });

  it("maps an operating-system probe timeout to compiler_unavailable", async () => {
    const result = await guard(configured(), async () => ({ ok: false, timedOut: true })).probe(150);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CompilerUnavailable);
    expect(result.error.details).toEqual({ timeoutMs: 150 });
  });
});
