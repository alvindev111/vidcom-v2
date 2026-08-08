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

  it("records every route handler that a static export would have to drop", async () => {
    const handlers = (await routeFiles("src/app"))
      .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
      .sort();

    // `output: "export"` fails on any force-dynamic route handler. These are the
    // ones that have to move before the export can be switched on, so the list
    // is pinned: a new handler added meanwhile shows up here rather than as a
    // build failure nobody expected.
    expect(handlers).toEqual([
      "src/app/api/[[...route]]/route.ts",
    ]);
  });
});
