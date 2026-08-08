import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { TOOL_SCHEMA_CATALOGUE } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

/**
 * Words that only appear in the filesystem-browsing surface.
 *
 * `/v1/system/*` lets a caller walk the machine's directory tree. It is
 * reachable from the UI over an authenticated loopback session, and that is the
 * only place it belongs: an agent that could enumerate the filesystem through a
 * tool call would have a capability the user never granted it.
 */
const BROWSE_SURFACE = [
  "filesystem_roots",
  "filesystem_entries",
  "browse_entries",
  "list_directories",
  "create_directory",
  "selection_token",
];

describe("filesystem browsing is not reachable over MCP", () => {
  it("declares no browsing tool in the schema catalogue", () => {
    const names = Object.keys(TOOL_SCHEMA_CATALOGUE);
    for (const forbidden of BROWSE_SURFACE) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it("declares no tool whose name suggests filesystem navigation", () => {
    // Broader than the exact list: a tool added later under a different name
    // should still fail here rather than ship.
    const suspicious = Object.keys(TOOL_SCHEMA_CATALOGUE).filter((name) =>
      /(^|_)(filesystem|directories|browse)(_|$)/u.test(name));
    expect(suspicious).toEqual([]);
  });

  it("registers no browsing route handler in the MCP tool modules", async () => {
    const registryDirectory = path.resolve("packages/mcp/src/registry");
    const offenders: string[] = [];
    for (const entry of await readdir(registryDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = await readFile(path.join(registryDirectory, entry.name), "utf8");
      // `/v1/system/` is the browsing surface's own prefix. Its presence in a
      // tool module means something is bridging it into the agent surface.
      if (source.includes("/v1/system/")) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the catalogue non-empty, so the check cannot pass vacuously", () => {
    // Without this, deleting every tool would make the assertions above green.
    expect(Object.keys(TOOL_SCHEMA_CATALOGUE).length).toBeGreaterThan(10);
  });
});
