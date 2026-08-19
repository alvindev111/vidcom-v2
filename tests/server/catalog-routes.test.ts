import { describe, expect, it } from "vitest";

import { type RelPath } from "@vidcom/contracts";
import { type CatalogItem, type CatalogListing } from "@vidcom/core";
import { Hono } from "hono";

import { createCatalogRoutes, mapHttpError, type CatalogRouteDependencies } from "@vidcom/server";

const COMMIT = "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c";
const ENTRY = "blocks/lower-third/index.html" as RelPath;

function remoteItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    name: "lower-third",
    kind: "block",
    title: "Lower third",
    description: "A lower third",
    tags: ["social"],
    category: "Social",
    version: `git:${COMMIT}`,
    integrity: null,
    materialization: "metadata",
    source: {
      registry: "hyperframes",
      url: `https://raw.githubusercontent.com/heygen-com/hyperframes/${COMMIT}/registry/blocks/lower-third/registry-item.json`,
      revision: COMMIT,
      committedAt: "2026-08-10T10:00:00Z",
    },
    dependencies: [],
    compatibility: { aspectRatios: null, minWidth: 1920, fps: null, minHyperframesVersion: null },
    durationSeconds: 4,
    entry: ENTRY,
    preview: null,
    ...overrides,
  };
}

interface Fakes {
  app: Hono;
  requests: { summary: string }[];
  issued: string[];
  prepared: unknown[];
  executed: unknown[];
}

function fakes(options: {
  listing?: CatalogListing;
  prepare?: unknown;
  execute?: unknown;
} = {}): Fakes {
  const state = { requests: [] as { summary: string }[], issued: [] as string[], prepared: [] as unknown[], executed: [] as unknown[] };
  const dependencies = {
    catalog: {
      list: async (filter) => options.listing ?? {
        items: [remoteItem()],
        source: "network",
        stale: false,
        ...(filter.kind === "template" ? { items: [] } : {}),
      } as CatalogListing,
    },
    install: {} as CatalogRouteDependencies["install"],
    approval: {
      request: async (_binding: never, summary: string) => {
        state.requests.push({ summary });
        return "grant_1";
      },
      issue: async (grantId: string) => { state.issued.push(grantId); return undefined; },
    },
  } satisfies CatalogRouteDependencies;
  const app = new Hono();
  // Same boundary mapping the real app installs, so a rejected schema is a 400
  // here for the same reason it is in production.
  app.onError((error, c) => mapHttpError(error, c));
  app.route("/", createCatalogRoutes(dependencies));
  return { app, ...state } as unknown as Fakes;
}

describe("catalog HTTP routes", () => {
  it("projects a listing without any registry URL or local path", async () => {
    const { app } = fakes();
    const response = await app.request("/v1/catalog");
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Record<string, unknown>[]; source: string; stale: boolean };
    expect(body.source).toBe("network");
    expect(body.stale).toBe(false);
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.source).toEqual({
      registry: "hyperframes",
      revision: COMMIT,
      committedAt: "2026-08-10T10:00:00Z",
    });
    expect(JSON.stringify(body)).not.toContain("raw.githubusercontent.com");
    expect(item.materialization).toBe("metadata");
    expect(item.integrity).toBeNull();
    expect(item.compatibilityWarning).toBeNull();
  });

  it("surfaces an incompatible runtime requirement as a warning, not an error", async () => {
    const { app } = fakes({
      listing: {
        items: [remoteItem({
          compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: "9.9.9" },
        })],
        source: "cache",
        stale: true,
      },
    });
    const body = await (await app.request("/v1/catalog")).json() as {
      items: { compatibilityWarning: unknown }[];
      stale: boolean;
    };
    expect(body.stale).toBe(true);
    expect(body.items[0]!.compatibilityWarning).toEqual({
      status: "incompatible",
      required: "9.9.9",
      runtime: "0.7.86",
    });
  });

  it("rejects an unknown filter kind and an oversized query", async () => {
    const { app } = fakes();
    expect((await app.request("/v1/catalog?kind=example")).status).toBe(400);
    expect((await app.request(`/v1/catalog?q=${"x".repeat(129)}`)).status).toBe(400);
  });

  it("rejects an install intent that carries a client-chosen digest or plan", async () => {
    const { app } = fakes();
    for (const body of [
      { name: "lower-third", version: "1.0.0", mount: { kind: "new-scene", toIndex: 0 }, expectedRevision: 1, integrity: "a".repeat(64) },
      { name: "lower-third", version: "1.0.0", mount: { kind: "new-scene", toIndex: 0 }, expectedRevision: 1, plan: {} },
      { name: "lower-third", version: "1.0.0", mount: { kind: "root" }, expectedRevision: 1 },
    ]) {
      const response = await app.request("/v1/projects/project_x/catalog-items/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});
