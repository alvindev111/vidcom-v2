import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "spikes/phase-0/.artifacts/**",
    "spikes/phase-0/next-route-precedence/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Bun",
          message: "Production packages run on Node; inject a runtime port instead of using Bun APIs.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["bun", "bun:*"],
              message: "Production packages must remain compatible with the Node SEA runtime.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["Bun", "process", "globalThis", "setInterval", "clearInterval", "setTimeout", "clearTimeout"].map((name) => ({
          name,
          message: "Core runtime capabilities must be supplied through injected ports.",
        })),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "bun",
                "bun:*",
                "@vidcom/adapter",
                "@vidcom/adapter/*",
                "@vidcom/cli",
                "@vidcom/cli/*",
                "@vidcom/mcp",
                "@vidcom/mcp/*",
                "@vidcom/server",
                "@vidcom/server/*",
                "@vidcom/worker",
                "@vidcom/worker/*",
                "hono",
                "hono/*",
                "next",
                "next/*",
                "react",
                "react/*",
                "node:*",
                "fs",
                "fs/*",
                "path",
                "path/*",
                "os",
                "os/*",
                "crypto",
                "crypto/*",
                "http",
                "http/*",
                "https",
                "https/*",
                "net",
                "net/*",
                "stream",
                "stream/*",
                "events",
                "events/*",
                "child_process",
                "worker_threads",
              ],
              message: "Core may depend only on contracts and injected ports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/adapter/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "bun",
                "bun:*",
                "@vidcom/mcp",
                "@vidcom/mcp/*",
                "@vidcom/server",
                "@vidcom/server/*",
                "next",
                "next/*",
                "react",
                "react/*",
              ],
              message: "Adapters implement Core ports and must not depend on transports or UI frameworks.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/server/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "bun",
                "bun:*",
                "@vidcom/mcp",
                "@vidcom/mcp/*",
                "next",
                "next/*",
                "react",
                "react/*",
              ],
              message: "The Hono server must remain independent from Next, React, and MCP transports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/mcp/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "bun",
                "bun:*",
                "@vidcom/server",
                "@vidcom/server/*",
                "next",
                "next/*",
                "react",
                "react/*",
              ],
              message: "MCP is a peer transport that calls Core directly, never through the HTTP server.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/worker/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "bun",
                "bun:*",
                "@vidcom/mcp",
                "@vidcom/mcp/*",
                "@vidcom/server",
                "@vidcom/server/*",
                "next",
                "next/*",
                "react",
                "react/*",
              ],
              message: "Workers call Core and adapters without depending on transport or UI packages.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@vidcom/*", "bun", "bun:*"],
              message: "Contracts are the dependency graph leaf and cannot import another VidCom package.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    // These are migration-only exceptions: Phase H turns the server modules
    // into adapters and Phase K/N removes the concrete Next routes. Keeping the
    // exception explicit lets new src/ code fail without pretending the legacy
    // cutover has already happened.
    ignores: [
      "src/app/api/[[...route]]/route.ts",
      "src/app/api/hf/**/*.ts",
      "src/lib/hyperframes/**/*.server.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@vidcom/adapter",
                "@vidcom/adapter/*",
                "@vidcom/core",
                "@vidcom/core/*",
                "@vidcom/mcp",
                "@vidcom/mcp/*",
                "@vidcom/server",
                "@vidcom/server/*",
                "node:*",
              ],
              message: "UI code may import only contract types; server access goes through the Hono API.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/api/[[...route]]/route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@vidcom/adapter",
                "@vidcom/adapter/*",
                "@vidcom/core",
                "@vidcom/core/*",
                "@vidcom/mcp",
                "@vidcom/mcp/*",
                "node:*",
              ],
              message: "The sole Next server entry may forward to @vidcom/server and contain no business logic.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
