import type { CompilerPreloadOptions } from "./compiler-preload";
import { configureCompilerBeforeRuntime } from "./compiler-preload";
import { COMPILER_PROBE_SENTINEL, COMPILER_PROBE_SUCCESS } from "./compiler-probe-protocol";

interface CliRuntime {
  runCliMain(argv: readonly string[]): Promise<number>;
}

/** Test seams for proving preload order without importing the production graph. */
export interface BootOptions {
  compiler?: CompilerPreloadOptions;
  loadRuntime?: () => Promise<CliRuntime>;
  runCompilerProbe?: () => Promise<string>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

/**
 * Configures esbuild, then and only then loads a compiler child or the CLI.
 *
 * Keeping both dynamic imports below the preload is the boot invariant. The
 * normal runtime statically imports the adapter barrel, whose HyperFrames root
 * imports evaluate esbuild even when the selected API itself does not compile.
 */
export async function runBootstrappedCli(
  argv: readonly string[],
  options: BootOptions = {},
): Promise<number> {
  try {
    await configureCompilerBeforeRuntime(options.compiler);
  } catch {
    // This boundary runs before the normal CLI graph exists, so it cannot use
    // runCliMain's mapper. A code-only line is stable and cannot leak the
    // manifest path or the build checkout carried by the preload exception.
    (options.stderr ?? process.stderr).write("compiler_unavailable\n");
    return 1;
  }
  if (argv[0] === COMPILER_PROBE_SENTINEL) {
    try {
      const runProbe = options.runCompilerProbe
        ?? (async () => (await import("@vidcom/adapter/compiler-probe-child")).runCompilerTransformProbe());
      await runProbe();
      (options.stdout ?? process.stdout).write(`${COMPILER_PROBE_SUCCESS}\n`);
      return 0;
    } catch {
      (options.stderr ?? process.stderr).write("compiler_unavailable\n");
      return 1;
    }
  }
  const runtime = await (options.loadRuntime ?? (() => import("./main")))();
  return runtime.runCliMain(argv);
}
