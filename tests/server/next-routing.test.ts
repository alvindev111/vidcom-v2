import { existsSync } from "node:fs";
import path from "node:path";

import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes.js";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("Next to Hono route precedence", () => {
  it("keeps exact routes ahead of the optional catch-all in pinned Next", () => {
    expect(getSortedRoutes([
      "/api/[[...route]]",
      "/api/hf/runtime",
      "/api/hf/[slug]/files/[...path]",
      "/api/hf/[slug]/preview",
    ])).toEqual([
      "/api/hf/runtime",
      "/api/hf/[slug]/files/[...path]",
      "/api/hf/[slug]/preview",
      "/api/[[...route]]",
    ]);
  });

  it("leaves the optional catch-all as the only Next server route after write cutover", () => {
    const api = path.join(root, "src/app/api");
    expect(existsSync(path.join(api, "[[...route]]/route.ts"))).toBe(true);
    expect(existsSync(path.join(api, "hf/runtime/route.ts"))).toBe(false);
    expect(existsSync(path.join(api, "hf/[slug]/preview/route.ts"))).toBe(false);
    expect(existsSync(path.join(api, "hf/[slug]/files/[...path]/route.ts"))).toBe(false);
    expect(existsSync(path.join(api, "hf/[slug]/source/route.ts"))).toBe(false);
    expect(existsSync(path.join(api, "hf/[slug]/preview-settings/route.ts"))).toBe(false);
    expect(existsSync(path.join(api, "hf/[slug]/scene/route.ts"))).toBe(false);
  });
});
