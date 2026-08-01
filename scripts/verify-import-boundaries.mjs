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
}

process.stdout.write("Core boundaries and Drizzle-only production persistence were verified.\n");
