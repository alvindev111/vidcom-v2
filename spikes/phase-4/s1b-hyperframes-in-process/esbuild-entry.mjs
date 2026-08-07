/**
 * S1b, second half — the esbuild question on its own.
 *
 * `@hyperframes/core/dist/compiler/index.js` calls `transformSync` and
 * `htmlBundler.js` calls `buildSync`. Both come from esbuild's JS wrapper,
 * which locates its *native* binary at runtime with `require.resolve("esbuild")`.
 * Bundling the wrapper into a SEA does not bring that binary along, so this
 * probe asks the decisive question directly instead of hoping a composition
 * happens to reach the compiler.
 */
// Imported by absolute path because esbuild is only a transitive dep of
// @hyperframes/core here — this is the exact module htmlBundler.js:8 imports.
import { transformSync } from "../../../node_modules/.bun/esbuild@0.25.12/node_modules/esbuild/lib/main.js";

const verdict = { execPath: process.execPath, steps: {} };

try {
  const out = transformSync("const answer = 42;", { loader: "js", minify: false, legalComments: "none" });
  verdict.steps.transformSync = { ok: true, code: out.code.trim() };
} catch (error) {
  verdict.steps.transformSync = { ok: false, error: String(error && error.message ? error.message : error) };
}

verdict.pass = Object.values(verdict.steps).every((s) => s.ok);
process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
process.exit(verdict.pass ? 0 : 1);
