import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("pass one or more markdown files");

const missing = [];
for (const file of files) {
  const markdown = readFileSync(file, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    let target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    target = decodeURIComponent(target);
    const resolved = path.resolve(path.dirname(file), target);
    if (!existsSync(resolved)) missing.push({ file, target });
  }
}

console.log(JSON.stringify({ checkedFiles: files.length, missing }, null, 2));
if (missing.length > 0) process.exitCode = 1;
