import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";

import { ESLint } from "eslint";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = path.join(
  repositoryRoot,
  "packages/core/src/boundary-violation.fixture.ts",
);
// lintText applies the real flat-config matcher for this Core path without
// creating a file that could race with a concurrently running repository lint.
const eslint = new ESLint({ cwd: repositoryRoot });
const fixtures = [
  ['import "@vidcom/adapter";\n', "adapter import"],
  ['import "fs/promises";\n', "bare Node builtin import"],
  ['import "node:http";\n', "node-prefixed builtin import"],
  ["process.cwd();\n", "process capability"],
  ["globalThis.setInterval(() => {}, 1);\n", "global timer capability"],
];
for (const [source, label] of fixtures) {
  const [result] = await eslint.lintText(source, { filePath: fixturePath });
  if (result.errorCount === 0) throw new Error(`Core accepted forbidden ${label}`);
}

function packageNameForImport(filename, specifier) {
  if (specifier.startsWith("@vidcom/")) return specifier.split("/").slice(0, 2).join("/");
  if (!specifier.startsWith(".")) return specifier;
  const target = path.resolve(path.dirname(filename), specifier);
  const relative = path.relative(path.join(repositoryRoot, "packages"), target);
  const [packageName] = relative.split(path.sep);
  return relative.startsWith("..") ? null : `@vidcom/${packageName}`;
}

// These rules mirror the import table in llm-documents/steering/02-project-layout.md §2
// and the per-package `no-restricted-imports` blocks in eslint.config.mjs. All three
// MUST say the same thing: ESLint catches bare specifiers, this script also catches
// relative imports that cross a package boundary, and the steering table is what
// humans read. Changing one alone produces a green `lint` with a red `test:boundaries`.
function assertPackageImportAllowed(filename, specifier) {
  const relative = path.relative(repositoryRoot, filename).split(path.sep).join("/");
  const targetPackage = packageNameForImport(filename, specifier);
  const usesMcpSdk = specifier === "@modelcontextprotocol/core"
    || specifier === "@modelcontextprotocol/server"
    || specifier.startsWith("@modelcontextprotocol/core/")
    || specifier.startsWith("@modelcontextprotocol/server/");
  if ((relative.startsWith("packages/core/") || relative.startsWith("packages/mcp/src/registry/")) && usesMcpSdk) {
    throw new Error(`SDK type leaked into Core/Registry: ${relative} -> ${specifier}`);
  }
  if (relative.startsWith("packages/mcp/") && targetPackage === "@vidcom/server") {
    throw new Error(`MCP must not import server: ${relative} -> ${specifier}`);
  }
  if (relative.startsWith("packages/server/") && targetPackage === "@vidcom/mcp") {
    throw new Error(`Server must not import MCP: ${relative} -> ${specifier}`);
  }
  if (relative.startsWith("packages/mcp/") && targetPackage === "@vidcom/adapter") {
    throw new Error(`MCP must not import sibling infrastructure: ${relative} -> ${specifier}`);
  }
}

const packageBoundaryFixtures = [
  ["packages/core/src/example.ts", "@modelcontextprotocol/server", "Core SDK import"],
  ["packages/mcp/src/registry/example.ts", "@modelcontextprotocol/core", "Registry SDK import"],
  ["packages/mcp/src/example.ts", "@vidcom/server", "MCP-to-server import"],
  ["packages/server/src/example.ts", "@vidcom/mcp", "server-to-MCP import"],
  ["packages/mcp/src/example.ts", "@vidcom/adapter", "MCP-to-adapter import"],
  // The two spellings someone reaches for once the bare specifier is refused.
  // `adapter/daemon` is a directory inside `@vidcom/adapter`, not a package of
  // its own, so a relative path to it is the same import wearing a hat — and
  // the scanner reads dynamic `import()` too, which is the other way round.
  [
    "packages/mcp/src/registry/example.ts",
    "../../../adapter/src/daemon/daemon-client",
    "MCP-to-adapter/daemon relative import",
  ],
];
for (const [relative, specifier, label] of packageBoundaryFixtures) {
  let rejected = false;
  try {
    assertPackageImportAllowed(path.join(repositoryRoot, relative), specifier);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Boundary fixture was not rejected: ${label}`);
}

async function productionSources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === "drizzle")) continue;
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await productionSources(pathname));
    else if (/\.(?:ts|tsx|js|mjs|json)$/.test(entry.name)) result.push(pathname);
  }
  return result;
}

for (const filename of await productionSources(path.join(repositoryRoot, "packages"))) {
  const source = await readFile(filename, "utf8");
  if (/\bfrom\s+["']kysely(?:\/[^"']*)?["']|["']kysely["']\s*:/.test(source)) {
    throw new Error(`Production persistence must remain Drizzle-only: ${path.relative(repositoryRoot, filename)}`);
  }
  for (const match of source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g)) {
    assertPackageImportAllowed(filename, match[1]);
  }
}

process.stdout.write("Core, package, MCP SDK, and Drizzle persistence boundaries were verified.\n");
