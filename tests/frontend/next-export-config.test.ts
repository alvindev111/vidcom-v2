import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function routeFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === "route.ts" || entry.name === "route.tsx") found.push(target);
    }
  };
  await visit(path.resolve(directory));
  return found;
}

describe("static export configuration", () => {
  it("states trailingSlash rather than relying on the default", async () => {
    // A static export writes /a/b.html or /a/b/index.html depending on this,
    // and the SEA asset host maps request paths onto those files. The two have
    // to agree, and agreeing by accident is how they drift apart.
    const config = await readFile(path.resolve("next.config.ts"), "utf8");
    expect(config).toContain("trailingSlash: false");
  });

  it("keeps HyperFrames packages external to the server bundle", async () => {
    // They reach into esbuild, a native binary, from the HTML compiler.
    const config = await readFile(path.resolve("next.config.ts"), "utf8");
    expect(config).toContain("serverExternalPackages");
    expect(config).toContain("@hyperframes/core");
  });

  it("builds a static export, with no Node rendering at request time", async () => {
    // The artifact serves the frontend out of a pack embedded in the
    // executable. Anything the export cannot emit ahead of time has no way to
    // be served there at all.
    const config = await readFile(path.resolve("next.config.ts"), "utf8");
    expect(config).toContain("output: \"export\"");
  });

  it("has no route handler left in the frontend", async () => {
    const handlers = (await routeFiles("src/app"))
      .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
      .sort();

    // `output: "export"` fails on any route handler, so this list has to stay
    // empty: the API belongs to the daemon, which the browser reaches over the
    // same loopback origin in the artifact and a configured one in
    // development. A handler added meanwhile shows up here rather than as a
    // build failure nobody expected.
    expect(handlers).toEqual([]);
  });
});
