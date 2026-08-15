import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SEA_BOOTSTRAP_ENTRY,
  assertBuiltinsOnlyBundle,
  buildSeaBootstrap,
  nonBuiltinRequires,
} from "../../scripts/build-sea-bootstrap.mjs";
import { containsBuildRootEncoding } from "../../scripts/build-root-provenance.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("primary SEA bootstrap bundle", () => {
  it("rejects every literal non-builtin require", () => {
    expect(nonBuiltinRequires("require('node:fs'); require('fs');")).toEqual([]);
    expect(nonBuiltinRequires("require('tar'); require('./outside.cjs');")).toEqual([
      "./outside.cjs",
      "tar",
    ]);
  });

  it("builds a parseable builtins-only primary without source-root leakage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-primary-bundle-"));
    roots.push(root);
    const outfile = path.join(root, "bootstrap.cjs");
    await buildSeaBootstrap(SEA_BOOTSTRAP_ENTRY, outfile);
    await expect(assertBuiltinsOnlyBundle(outfile)).resolves.toBeUndefined();
    expect(containsBuildRootEncoding(await readFile(outfile, "utf8"), process.cwd())).toBe(false);

    // Outside a real SEA this must only define the loader; requiring it proves
    // the rewritten file URLs remain syntactically and semantically usable.
    const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(outfile)})`], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);
});
