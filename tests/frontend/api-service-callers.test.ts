import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const LEGACY_RAW_API_CALLS = {};

const RAW_API_CALL = /\b(?:fetch|(?:new\s+)?EventSource)\s*\(\s*["'`]\/api/gu;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe("frontend API service callers", () => {
  it("does not add raw API fetch or EventSource calls outside shared helpers", async () => {
    const found: Record<string, number> = {};
    for (const file of await sourceFiles("src")) {
      const source = await readFile(file, "utf8");
      const count = source.match(RAW_API_CALL)?.length ?? 0;
      if (count > 0) {
        found[relative(process.cwd(), file).replaceAll("\\", "/")] = count;
      }
    }

    // Keep this explicit so a future raw caller fails instead of silently
    // bypassing runtime base-url resolution and session credentials.
    expect(found).toEqual(LEGACY_RAW_API_CALLS);
  });
});
