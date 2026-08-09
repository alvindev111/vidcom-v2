import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["packages/adapter/src", "packages/cli/src", "packages/server/src", "packages/worker/src"];

/**
 * Anything that can reach esbuild in-process.
 *
 * `hyperframes` compiles through esbuild, so a call into it is a compiler call
 * whether or not the word esbuild appears at the call site.
 */
// A bare `build(` is far too generic — it matched a foundation builder that
// never touches a compiler. Same over-reach as matching bare `exec(` in the
// spawn audit: the names to look for have to be esbuild-specific.
const COMPILER_TOUCH = /\b(esbuild|transformSync|buildSync|hyperframesCommand)/u;

/**
 * Files that may mention the compiler without going through CompilerGuard.
 *
 * The guard is the only thing standing between a misconfigured environment and
 * a hang with no output, so a compiler call outside it has to be a call that
 * cannot hang: a type, a constant, or a command array handed to the supervised
 * process runner, which enforces its own timeout.
 */
const EXEMPT = new Map<string, string>([
  [
    "packages/adapter/src/hyperframes/compiler-guard.ts",
    "is the guard",
  ],
  [
    "packages/adapter/src/hyperframes/binary-probe.ts",
    "assembles the command array and probes binaries; every spawn it makes"
    + " already carries an explicit timeout",
  ],
  [
    "packages/core/src/port/ports.ts",
    "declares the command type and executes nothing",
  ],
  [
    "packages/cli/src/commands/doctor-repair.ts",
    "lists `runtime.esbuild-binary` as a check id it may re-extract; it runs"
    + " nothing and the probe that does carries its own timeout",
  ],
  [
    "packages/adapter/src/runtime/runtime-asset-source.ts",
    "names esbuild as a pinned version field in the manifest schema; it records"
    + " which compiler shipped and never invokes one",
  ],
]);

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".ts")) found.push(target);
    }
  };
  await visit(path.resolve(root));
  return found;
}

describe("compiler timeout audit", () => {
  it("leaves no compiler path without a timeout", async () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of await sourceFiles(root)) {
        const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
        if (EXEMPT.has(relative)) continue;
        const source = await readFile(file, "utf8");
        if (!COMPILER_TOUCH.test(source)) continue;
        const guarded = source.includes("CompilerGuard")
          || source.includes("timeoutMs")
          || source.includes("timeout:");
        if (!guarded) offenders.push(relative);
      }
    }
    // A new compiler call is expected to fail here until it either runs through
    // the guard, carries its own timeout, or is listed above with a reason.
    expect(offenders).toEqual([]);
  });

  it("keeps every exemption pointing at a file that still mentions the compiler", async () => {
    for (const [relative] of EXEMPT) {
      const source = await readFile(path.resolve(relative), "utf8");
      expect(COMPILER_TOUCH.test(source), `${relative} no longer touches the compiler`).toBe(true);
    }
  });
});
