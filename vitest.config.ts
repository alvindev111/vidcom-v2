import path from "node:path";

import { defineConfig } from "vitest/config";

// These suites drive a real SQLite file and a real temp-directory workspace.
// Windows pays for an ACL subprocess per protected file plus far slower
// filesystem metadata and recursive removal, so the identical work needs a
// larger budget there. Keeping macOS/Linux tight preserves the hang signal.
const slowPlatform = process.platform === "win32";
const testTimeout = slowPlatform ? 30_000 : 5_000;
const hookTimeout = slowPlatform ? 60_000 : 10_000;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@vidcom/agent-kit": path.resolve(import.meta.dirname, "packages/agent-kit/src/index.ts"),
      "@vidcom/adapter/compiler-guard": path.resolve(
        import.meta.dirname,
        "packages/adapter/src/hyperframes/compiler-guard.ts",
      ),
      "@vidcom/adapter/compiler-probe-child": path.resolve(
        import.meta.dirname,
        "packages/adapter/src/hyperframes/compiler-probe-child.ts",
      ),
      "@vidcom/adapter/runtime-bootstrap": path.resolve(
        import.meta.dirname,
        "packages/adapter/src/runtime/runtime-bootstrap.ts",
      ),
      "@vidcom/adapter": path.resolve(import.meta.dirname, "packages/adapter/src/index.ts"),
      "@vidcom/cli": path.resolve(import.meta.dirname, "packages/cli/src/index.ts"),
      "@vidcom/contracts": path.resolve(
        import.meta.dirname,
        "packages/contracts/src/index.ts",
      ),
      "@vidcom/core": path.resolve(import.meta.dirname, "packages/core/src/index.ts"),
      "@vidcom/mcp": path.resolve(import.meta.dirname, "packages/mcp/src/index.ts"),
      "@vidcom/server": path.resolve(import.meta.dirname, "packages/server/src/index.ts"),
      "@vidcom/worker": path.resolve(import.meta.dirname, "packages/worker/src/index.ts"),
      "server-only": path.resolve(
        import.meta.dirname,
        "tests/support/server-only.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout,
    hookTimeout,
    // Windows performs an ACL subprocess for protected files and serializes
    // SQLite cleanup behind open handles. Unbounded file parallelism made
    // otherwise-fast integration tests consume their explicit 15/30 s budgets
    // only in the full Actions suite, while each one passed alone.
    maxWorkers: slowPlatform ? 1 : undefined,
  },
});
