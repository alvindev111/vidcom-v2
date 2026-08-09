import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ARTIFACT_ALLOWLIST,
  FORBIDDEN_PATTERNS,
  formatChecksums,
  scanForForbidden,
  unexpectedEntries,
} from "../../scripts/verify-artifact.mjs";
import { buildFrontendPack } from "../../scripts/build-frontend-pack.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact content scan", () => {
  it.each([
    ["a development origin", "fetch('http://localhost:3000/api')", "dev-origin"],
    ["a sourcemap link", "//# sourceMappingURL=main.js.map", "sourcemap-url"],
    ["an AWS key", "const k = 'AKIAIOSFODNN7EXAMPLE'", "aws-key"],
    ["an API key", "const k = 'sk-abcdefghijklmnopqrstuvwxyz'", "openai-key"],
    ["a private key", "-----BEGIN PRIVATE KEY-----", "private-key"],
  ])("refuses %s", (_label, text, id) => {
    // Each of these is invisible until it is embarrassing: a key that works, a
    // sourcemap that hands over the whole source, an origin pointing at a
    // machine that does not exist for the user.
    expect(scanForForbidden(text, "").map((hit) => hit.id)).toContain(id);
  });

  it("refuses the build machine's own directory", () => {
    // It says nothing about the user's install and everything about ours.
    expect(scanForForbidden("built from /Users/builder/vidcom", "/Users/builder/vidcom")
      .map((hit) => hit.id)).toContain("build-root");
  });

  it("reports everything it found, not the first thing", () => {
    // A build that leaked two things should say so once, rather than across two
    // runs.
    const hits = scanForForbidden(
      "http://localhost:3000 and AKIAIOSFODNN7EXAMPLE",
      "",
    );
    expect(hits).toHaveLength(2);
  });

  it("passes ordinary content", () => {
    expect(scanForForbidden("const answer = 42;", "/Users/builder/vidcom")).toEqual([]);
  });

  it("gives every rule a reason a reader can act on", () => {
    for (const rule of FORBIDDEN_PATTERNS) {
      expect(rule.why, rule.id).toBeTruthy();
    }
  });
});

describe("artifact directory", () => {
  it("holds the executable and its provenance, and nothing else", () => {
    // A stray `.map` or `.ts` beside the executable is the same leak as one
    // embedded in it, and easier to miss.
    expect(unexpectedEntries(["vidcom", "SHA256SUMS", "artifact-manifest.json"])).toEqual([]);
    expect(unexpectedEntries(["vidcom", "main.cjs.map"])).toEqual(["main.cjs.map"]);
    expect([...ARTIFACT_ALLOWLIST].sort()).toEqual([
      "SHA256SUMS",
      "artifact-manifest.json",
      "vidcom",
      "vidcom.exe",
    ]);
  });

  it("writes checksums in the format a user's own tool reads", () => {
    // `sha256sum -c` rather than a shape that needs a tool we ask them to
    // install.
    expect(formatChecksums({ vidcom: "abc123" })).toBe("abc123  vidcom\n");
  });
});

describe("the frontend pack this build produces", () => {
  it("carries no development origin", async () => {
    // The dev origin is injected at runtime by the host and never inlined, so
    // there is nothing to leak — and this is the check that keeps it that way.
    // The export is built here when it is missing, because the CI job runs the
    // tests before the production build and a skipped check is one nobody
    // notices went missing.
    if (!existsSync(path.resolve("out"))) {
      const built = spawnSync("npm", ["run", "build"], { stdio: "ignore", shell: false });
      expect(built.status, "the static export could not be built").toBe(0);
    }
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-provenance-")));
    roots.push(root);
    const packPath = path.join(root, "frontend.pack");
    const manifestPath = path.join(root, "frontend-manifest.json");
    await buildFrontendPack(path.resolve("out"), packPath, manifestPath);

    const pack = await readFile(packPath, "latin1");
    expect(scanForForbidden(pack, process.cwd())).toEqual([]);
  }, 300_000);
});
