import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
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
  },
});
