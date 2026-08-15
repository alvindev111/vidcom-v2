import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CompilerGuard,
  ESBUILD_BINARY_PATH,
  ESBUILD_WORKER_THREADS,
  NodeProcessSupervisor,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { compilerProbeCommand, runCompilerProbeProcess } from "../../packages/cli/src/compiler-probe";
import { resolveDevelopmentEsbuildBinary } from "../../packages/cli/src/compiler-preload";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-compiler-process-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiler process boundary", () => {
  it("runs a real HyperFrames transform through a real child and temporary filesystem", async () => {
    const appDataRoot = await scratch();
    const esbuildBinaryPath = resolveDevelopmentEsbuildBinary();
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      [ESBUILD_BINARY_PATH]: esbuildBinaryPath,
      [ESBUILD_WORKER_THREADS]: "0",
    };
    const guard = new CompilerGuard({
      esbuildBinaryPath,
      environment,
      probeRunner: (timeoutMs) => runCompilerProbeProcess({
        supervisor: new NodeProcessSupervisor(),
        command: compilerProbeCommand(false),
        environment: {
          [ESBUILD_BINARY_PATH]: esbuildBinaryPath,
          [ESBUILD_WORKER_THREADS]: "0",
          VIDCOM_APP_DATA: appDataRoot,
        },
        timeoutMs,
      }),
    });

    const result = await guard.probe(20_000);

    expect(result).toEqual({ ok: true, value: "compiler transform completed" });
  }, 30_000);

  it("kills an unresponsive child instead of relying on an event-loop timer", async () => {
    const esbuildBinaryPath = resolveDevelopmentEsbuildBinary();
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      [ESBUILD_BINARY_PATH]: esbuildBinaryPath,
      [ESBUILD_WORKER_THREADS]: "0",
    };
    const guard = new CompilerGuard({
      esbuildBinaryPath,
      environment,
      probeRunner: (timeoutMs) => runCompilerProbeProcess({
        supervisor: new NodeProcessSupervisor(),
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        environment: {
          [ESBUILD_BINARY_PATH]: esbuildBinaryPath,
          [ESBUILD_WORKER_THREADS]: "0",
        },
        timeoutMs,
      }),
    });

    const result = await guard.probe(150);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CompilerUnavailable);
    expect(result.error.details).toEqual({ timeoutMs: 150 });
  });
});
