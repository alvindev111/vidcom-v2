import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PROBE_COMMENT = "vidcom compiler probe comment";
const PROBE_SOURCE = `<!doctype html>
<html>
  <head></head>
  <body>
    <div data-composition-id="compiler-probe" data-width="16" data-height="16" data-start="0" data-duration="1"></div>
    <script>
      const answer = 42; // ${PROBE_COMMENT}
      window.__vidcomCompilerProbe = answer;
    </script>
  </body>
</html>`;

/**
 * Runs HyperFrames' real JavaScript transform against a temporary project.
 *
 * This function is child-only. `bundleToSingleHtml` eventually calls
 * esbuild's synchronous API, so the parent must supervise and kill this whole
 * process on timeout; a JavaScript timer inside this process cannot interrupt
 * a blocked `transformSync`.
 */
export async function runCompilerTransformProbe(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-compiler-probe-"));
  try {
    await writeFile(path.join(root, "index.html"), PROBE_SOURCE, "utf8");
    // Dynamic, not a ninth static adapter import: compiler initialization is
    // permitted only after the entry preload configured both esbuild variables.
    const { bundleToSingleHtml } = await import("@hyperframes/core/compiler");
    const output = await bundleToSingleHtml(root, { runtime: "placeholder" });
    if (!output.includes("const answer = 42") || output.includes(PROBE_COMMENT)) {
      throw new Error("the HyperFrames compiler returned HTML without applying the JavaScript transform");
    }
    return "compiler transform completed";
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
