import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["packages/adapter/src", "packages/cli/src", "packages/server/src", "packages/worker/src"];
// The lookbehind matters: `client.exec(` is SQLite and `pattern.exec(` is a
// regex. Matching bare `exec(` reported five call sites that spawn nothing.
const SPAWN_CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/u;

/**
 * Files allowed to spawn without `allowlistedEnvironment`, each for a reason.
 *
 * Every other spawn must go through the helper: it is the single place that
 * forces UTF-8 and carries the certificate bundle, so a spawn that builds its
 * own environment loses both protections at once and nothing reports it.
 */
const EXEMPT = new Map<string, string>([
  [
    "packages/adapter/src/runtime/process-supervisor.ts",
    "owns the helper's only production caller, and its OS probes run fixed"
    + " read-only commands under an environment built for that purpose",
  ],
  [
    "packages/adapter/src/fs/credential-store.ts",
    "runs whoami and icacls to apply an ACL; they take no user input and are"
    + " unaffected by encoding or certificates",
  ],
  [
    "packages/cli/src/main.ts",
    "launches the UI host and the OS browser opener, neither of which is a"
    + " supervised toolchain child",
  ],
]);

async function sourceFiles(root: string): Promise<string[]> {
  const absolute = path.resolve(root);
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".ts")) found.push(target);
    }
  };
  await visit(absolute);
  return found;
}

describe("spawn environment audit", () => {
  it("routes every toolchain spawn through allowlistedEnvironment", async () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of await sourceFiles(root)) {
        const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
        if (EXEMPT.has(relative)) continue;
        const source = await readFile(file, "utf8");
        if (!SPAWN_CALL.test(source)) continue;
        if (!source.includes("allowlistedEnvironment")) offenders.push(relative);
      }
    }
    // A new spawn point is expected to fail this until it either uses the
    // helper or is listed above with its reason.
    expect(offenders).toEqual([]);
  });

  it("keeps every exemption pointing at a file that still spawns", async () => {
    // An exemption outliving its spawn is a hole left open for the next one.
    for (const [relative] of EXEMPT) {
      const source = await readFile(path.resolve(relative), "utf8");
      expect(SPAWN_CALL.test(source), `${relative} no longer spawns`).toBe(true);
    }
  });

  it("documents a reason for every exemption", () => {
    for (const [relative, reason] of EXEMPT) {
      expect(reason.length, `${relative} has no reason`).toBeGreaterThan(20);
    }
  });
});
