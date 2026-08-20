import { readFile } from "node:fs/promises";

import ts from "typescript";

const lockPath = new URL("../bun.lock", import.meta.url);
const source = await readFile(lockPath, "utf8");
const parsed = ts.parseConfigFileTextToJson("bun.lock", source);
if (parsed.error) throw new Error(`bun.lock could not be parsed: ${parsed.error.messageText}`);

const packages = parsed.config?.packages;
if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
  throw new Error("bun.lock has no package provenance table");
}

const errors = [];
let registryCount = 0;
let workspaceCount = 0;
for (const [key, value] of Object.entries(packages)) {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    errors.push(`${key}: malformed package record`);
    continue;
  }
  const resolution = value[0];
  if (resolution.includes("@workspace:")) {
    workspaceCount += 1;
    continue;
  }
  registryCount += 1;
  if (value[1] !== "") errors.push(`${key}: non-registry source is not approved`);
  if (!/^[A-Za-z0-9@][^\s]*@[^\s]+$/u.test(resolution)) {
    errors.push(`${key}: resolution is not an exact package version`);
  }
  if (typeof value[3] !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value[3])) {
    errors.push(`${key}: registry package has no sha512 integrity`);
  }
}

if (registryCount === 0 || workspaceCount === 0) errors.push("lockfile package coverage is incomplete");
if (errors.length > 0) throw new Error(`dependency provenance failed:\n${errors.join("\n")}`);
process.stdout.write(`dependency provenance ok: ${registryCount} registry + ${workspaceCount} workspace packages\n`);
