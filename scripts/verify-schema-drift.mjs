import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationRoot = path.join(repositoryRoot, "packages/adapter/drizzle");

async function snapshotTree(directory, prefix = "") {
  const snapshot = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, digest] of await snapshotTree(pathname, relative)) snapshot.set(name, digest);
    } else {
      snapshot.set(relative, createHash("sha256").update(await readFile(pathname)).digest("hex"));
    }
  }
  return snapshot;
}

const before = await snapshotTree(migrationRoot);
const generated = spawnSync("bun", ["run", "db:generate"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
process.stdout.write(generated.stdout);
process.stderr.write(generated.stderr);
if (generated.status !== 0) process.exit(generated.status ?? 1);

const after = await snapshotTree(migrationRoot);
const changed = [...new Set([...before.keys(), ...after.keys()])]
  .filter((name) => before.get(name) !== after.get(name))
  .sort();
if (changed.length > 0) {
  throw new Error(`Drizzle schema drift changed migration artifacts:\n${changed.join("\n")}`);
}
process.stdout.write(`Schema and ${after.size} migration artifacts are in sync.\n`);
