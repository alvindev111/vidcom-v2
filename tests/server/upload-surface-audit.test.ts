import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { MAX_BGM_BYTES, MAX_SOURCE_BYTES } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

/**
 * Routes allowed to accept a body larger than the 1 MiB default.
 *
 * Every entry is a place where an unauthenticated size becomes memory. The
 * checklist surveyed this surface and found exactly one binary upload; a second
 * one appearing means the surface changed since that survey, which is a thing
 * to stop and record rather than another exception to wave through.
 */
const RAISED_LIMITS = new Map<string, number>([
  ["/v1/projects/:id/files", MAX_SOURCE_BYTES],
  ["/v1/projects/:id/assets/bgm", MAX_BGM_BYTES],
]);

async function serverSources(): Promise<string[]> {
  const root = path.resolve("packages/server/src");
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".ts")) found.push(target);
    }
  };
  await visit(root);
  return found;
}

describe("upload surface", () => {
  it("raises the body limit for exactly the surveyed routes", async () => {
    const app = await readFile(path.resolve("packages/server/src/app.ts"), "utf8");

    // The limits live on one fixed middleware link, so the set of exceptions is
    // readable in one place rather than scattered across route files.
    expect(app).toContain("maxSize: 1_048_576");
    expect(app).toContain("MAX_SOURCE_BYTES");
    expect(app).toContain("MAX_BGM_BYTES");
    expect(RAISED_LIMITS.get("/v1/projects/:id/assets/bgm")).toBe(20 * 1024 * 1024);
  });

  it("finds no second route reading a binary body", async () => {
    const offenders: string[] = [];
    for (const file of await serverSources()) {
      const source = await readFile(file, "utf8");
      // `arrayBuffer()` is how a route turns a request into bytes. formData is
      // allowed on its own; it is the buffer read that commits memory.
      if (!source.includes("arrayBuffer()")) continue;
      const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
      if (relative !== "packages/server/src/routes/project-writes.ts") offenders.push(relative);
    }

    // A hit here means the upload surface grew since the checklist surveyed it.
    // Stop and record it rather than adding an exception.
    expect(offenders).toEqual([]);
  });

  it("keeps the raised limits well under anything that would exhaust memory", () => {
    for (const [route, limit] of RAISED_LIMITS) {
      expect(limit, route).toBeLessThanOrEqual(20 * 1024 * 1024);
    }
  });

  it("bypasses collection only for the authenticated raw asset stream", async () => {
    const app = await readFile(path.resolve("packages/server/src/app.ts"), "utf8");
    const routes = await readFile(path.resolve("packages/server/src/routes/project-writes.ts"), "utf8");

    expect(app).toContain('c.req.method === "POST"');
    expect(app).toContain('/\\/v1\\/projects\\/[^/]+\\/assets$/');
    expect(routes).toContain('routes.post("/v1/projects/:id/assets"');
    const start = routes.indexOf('routes.post("/v1/projects/:id/assets"');
    const end = routes.indexOf("\n  routes.", start + 1);
    const rawRoute = routes.slice(start, end);
    expect(rawRoute).toContain("c.req.raw.body");
    expect(rawRoute).not.toContain("arrayBuffer()");
    expect(rawRoute).not.toContain("formData()");
  });
});
