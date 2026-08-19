import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CATALOG_REGISTRY_HOSTS,
  HyperframesRegistryCatalog,
  type CatalogHttpOptions,
} from "@vidcom/adapter";
import { type CatalogItem } from "@vidcom/core";

const COMMIT = "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c";
const COMMITTED_AT = "2026-08-10T10:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-catalog-cache-"));
  roots.push(root);
  return root;
}

function blockManifest(name: string, dependencies: string[] = []): unknown {
  return {
    name,
    type: "hyperframes:block",
    title: `Block ${name}`,
    description: `${name} description`,
    tags: ["social"],
    dimensions: { width: 1920, height: 1080 },
    duration: 4,
    registryDependencies: dependencies,
    files: [
      { path: "index.html", target: `blocks/${name}/index.html`, type: "hyperframes:composition" },
    ],
  };
}

function bundledItem(name = "title-card"): CatalogItem {
  return {
    name,
    kind: "template",
    title: "Title card",
    description: null,
    tags: ["intro"],
    category: "Openers",
    version: "1.0.0",
    integrity: {
      algo: "sha256",
      files: { ["templates/x/scene.html" as CatalogItem["entry"]]: "a".repeat(64) },
      manifest: "b".repeat(64),
    },
    materialization: "verified",
    source: { registry: "bundled", url: null, revision: null, committedAt: null },
    dependencies: [],
    compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
    durationSeconds: 4,
    entry: "templates/x/scene.html" as CatalogItem["entry"],
    preview: null,
  };
}

interface FakeRegistry {
  fetch: NonNullable<CatalogHttpOptions["fetch"]>;
  urls: string[];
  concurrency: { peak: number };
}

/** Serves a small registry over the injected fetch seam; never a real socket. */
function fakeRegistry(options: {
  names?: string[];
  manifests?: Record<string, unknown>;
  indexBody?: unknown;
  delayMs?: number;
} = {}): FakeRegistry {
  const names = options.names ?? ["lower-third", "wipe-left"];
  const urls: string[] = [];
  const concurrency = { peak: 0 };
  let active = 0;
  const fetch = (async (input: URL | string) => {
    const url = String(input);
    urls.push(url);
    active += 1;
    concurrency.peak = Math.max(concurrency.peak, active);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (url.endsWith("/commits/main")) {
        return Response.json({ sha: COMMIT, commit: { committer: { date: COMMITTED_AT } } });
      }
      if (url.endsWith("/registry.json")) {
        return Response.json(options.indexBody ?? {
          name: "hyperframes",
          homepage: "https://hyperframes.heygen.com",
          items: names.map((name) => ({ name, type: "hyperframes:block" })),
        });
      }
      const matched = names.find((name) => url.endsWith(`/blocks/${name}/registry-item.json`));
      if (matched) {
        return Response.json(options.manifests?.[matched] ?? blockManifest(matched));
      }
      return new Response("not found", { status: 404 });
    } finally {
      active -= 1;
    }
  }) as NonNullable<CatalogHttpOptions["fetch"]>;
  return { fetch, urls, concurrency };
}

function catalogFor(
  root: string,
  registry: Pick<FakeRegistry, "fetch">,
  overrides: { now?: () => number; bundled?: CatalogItem[] } = {},
): HyperframesRegistryCatalog {
  return new HyperframesRegistryCatalog({
    cacheRoot: root,
    bundled: async () => overrides.bundled ?? [bundledItem()],
    now: overrides.now ?? (() => Date.parse("2026-08-11T00:00:00Z")),
    http: { fetch: registry.fetch, resolveHost: async () => ["8.8.8.8"] },
  });
}

describe("catalog registry transport and cache", () => {
  it("pins the resolved commit and never requests a branch path or a payload file", async () => {
    const registry = fakeRegistry();
    const catalog = catalogFor(await cacheRoot(), registry);
    const listing = await catalog.list({});
    expect(listing.source).toBe("network");
    expect(listing.stale).toBe(false);
    // Bundled templates stay listed beside the registry blocks: they are the only
    // source of `kind: "template"`, so dropping them when the network answers
    // would make templates vanish exactly when the app is online.
    expect(listing.items.map((item) => item.name)).toEqual(["title-card", "lower-third", "wipe-left"]);
    const remote = listing.items.filter((item) => item.source.registry === "hyperframes");
    expect(remote.every((item) => item.version === `git:${COMMIT}`)).toBe(true);
    expect(remote.every((item) => item.materialization === "metadata")).toBe(true);

    expect(registry.urls[0]).toBe("https://api.github.com/repos/heygen-com/hyperframes/commits/main");
    for (const url of registry.urls.slice(1)) {
      expect(url).toContain(`/${COMMIT}/`);
      expect(url).not.toContain("/main/");
    }
    // Opening the catalog must not download package bytes.
    expect(registry.urls.some((url) => url.endsWith("index.html"))).toBe(false);
    expect(registry.urls).toHaveLength(4);
  });

  it("keeps only the allowlisted registry hosts and rejects anything else", async () => {
    expect([...CATALOG_REGISTRY_HOSTS].sort())
      .toEqual(["api.github.com", "raw.githubusercontent.com"]);
    const registry = fakeRegistry();
    const catalog = catalogFor(await cacheRoot(), registry);
    await expect(catalog.fetchJson(new URL("https://evil.example/registry.json"), 1_024))
      .rejects.toThrow(/allowlist/u);
    await expect(catalog.fetchJson(new URL("http://api.github.com/x"), 1_024))
      .rejects.toThrow(/HTTPS/u);
  });

  it("follows at most three allowlisted redirects and revalidates every hop", async () => {
    const root = await cacheRoot();
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

    const offHost = catalogFor(root, {
      fetch: (async () => redirect("https://evil.example/x")) as FakeRegistry["fetch"],
    });
    await expect(offHost.fetchJson(new URL("https://api.github.com/a"), 1_024))
      .rejects.toThrow(/allowlist/u);

    const downgrade = catalogFor(root, {
      fetch: (async () => redirect("http://api.github.com/x")) as FakeRegistry["fetch"],
    });
    await expect(downgrade.fetchJson(new URL("https://api.github.com/a"), 1_024))
      .rejects.toThrow(/HTTPS/u);

    let hops = 0;
    const loop = catalogFor(root, {
      fetch: (async () => {
        hops += 1;
        return redirect(`https://api.github.com/hop-${hops}`);
      }) as FakeRegistry["fetch"],
    });
    await expect(loop.fetchJson(new URL("https://api.github.com/a"), 1_024))
      .rejects.toThrow(/redirect/u);
    expect(hops).toBe(4);

    // Every hop resolves DNS again, so a second answer pointing at a private
    // address cannot be reached through an allowlisted first hop.
    let resolutions = 0;
    const rebind = new HyperframesRegistryCatalog({
      cacheRoot: root,
      bundled: async () => [],
      http: {
        resolveHost: async () => [++resolutions === 1 ? "8.8.8.8" : "127.0.0.1"],
        fetch: (async (input: URL | string) => String(input).endsWith("/a")
          ? redirect("https://raw.githubusercontent.com/b")
          : Response.json({})) as FakeRegistry["fetch"],
      },
    });
    await expect(rebind.fetchJson(new URL("https://api.github.com/a"), 1_024))
      .rejects.toThrow(/public/u);
    expect(resolutions).toBe(2);
  });

  it("propagates the caller signal and bounds every response body", async () => {
    const root = await cacheRoot();
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const catalog = catalogFor(root, {
      fetch: (async (_input: URL | string, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return Response.json({});
      }) as FakeRegistry["fetch"],
    });
    const pending = catalog.fetchJson(new URL("https://api.github.com/a"), 1_024, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(seen[0]).toBeInstanceOf(AbortSignal);

    const oversize = catalogFor(root, {
      fetch: (async () => new Response("x".repeat(4_096))) as FakeRegistry["fetch"],
    });
    await expect(oversize.fetchJson(new URL("https://api.github.com/a"), 1_024))
      .rejects.toThrow(/too large/u);
  });

  it("serves a fresh cache with no network and refreshes a stale one in the background", async () => {
    const root = await cacheRoot();
    const first = fakeRegistry();
    const fresh = catalogFor(root, first);
    await fresh.list({});
    expect(await readdir(root)).toEqual(["manifest.json", "meta.json"].sort());

    const second = fakeRegistry();
    const cached = catalogFor(root, second, { now: () => Date.parse("2026-08-11T00:00:01Z") });
    const hit = await cached.list({});
    expect(hit.source).toBe("cache");
    expect(hit.stale).toBe(false);
    expect(second.urls).toEqual([]);

    const third = fakeRegistry({ names: ["lower-third", "wipe-left", "fresh-block"] });
    const stale = catalogFor(root, third, {
      now: () => Date.parse("2026-08-11T00:00:00Z") + DAY_MS + 1,
    });
    const served = await stale.list({});
    expect(served.source).toBe("cache");
    expect(served.stale).toBe(true);
    expect(served.items).toHaveLength(3);
    await stale.whenIdle();
    const afterRefresh = await stale.list({});
    expect(afterRefresh.items).toHaveLength(4);
  });

  it("falls back to bundled items and does not retry a failure for a minute", async () => {
    const root = await cacheRoot();
    let attempts = 0;
    let clock = Date.parse("2026-08-11T00:00:00Z");
    const catalog = new HyperframesRegistryCatalog({
      cacheRoot: root,
      bundled: async () => [bundledItem()],
      now: () => clock,
      http: {
        resolveHost: async () => ["8.8.8.8"],
        fetch: (async () => {
          attempts += 1;
          throw new Error("offline");
        }) as FakeRegistry["fetch"],
      },
    });
    const offline = await catalog.list({});
    expect(offline.source).toBe("bundled");
    expect(offline.stale).toBe(false);
    expect(offline.items.map((item) => item.name)).toEqual(["title-card"]);
    expect(attempts).toBe(1);

    clock += 30_000;
    await catalog.list({});
    expect(attempts).toBe(1);

    clock += 31_000;
    await catalog.list({});
    expect(attempts).toBe(2);
  });

  it("returns immediately from cache while the network hangs", async () => {
    const root = await cacheRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ revision: COMMIT, committedAt: COMMITTED_AT, items: [] }),
      "utf8",
    );
    await writeFile(
      path.join(root, "meta.json"),
      JSON.stringify({ fetchedAt: 0, etag: null, revision: COMMIT }),
      "utf8",
    );
    let released = () => {};
    const hang = new Promise<void>((resolve) => { released = resolve; });
    const catalog = new HyperframesRegistryCatalog({
      cacheRoot: root,
      bundled: async () => [bundledItem()],
      now: () => Date.parse("2026-08-11T00:00:00Z"),
      http: {
        resolveHost: async () => ["8.8.8.8"],
        fetch: (async () => { await hang; return Response.json({}); }) as FakeRegistry["fetch"],
      },
    });
    const listing = await Promise.race([
      catalog.list({}),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("list waited for the network")), 500)),
    ]) as Awaited<ReturnType<HyperframesRegistryCatalog["list"]>>;
    expect(listing.stale).toBe(true);
    released();
    await catalog.whenIdle().catch(() => undefined);
  });

  it("collapses concurrent refreshes into one network pass and caps manifest concurrency", async () => {
    const registry = fakeRegistry({
      names: Array.from({ length: 20 }, (_, index) => `block-${index}`),
      delayMs: 10,
    });
    const catalog = catalogFor(await cacheRoot(), registry, { bundled: [] });
    const [left, right] = await Promise.all([catalog.list({}), catalog.list({})]);
    expect(left.items).toHaveLength(20);
    expect(right.items).toHaveLength(20);
    // One commit resolve, one index, twenty manifests: not two passes.
    expect(registry.urls).toHaveLength(22);
    expect(registry.concurrency.peak).toBeLessThanOrEqual(8);
  });

  it("rejects an oversized index, too many items and drops one invalid manifest", async () => {
    const many = catalogFor(await cacheRoot(), fakeRegistry({
      indexBody: {
        name: "hyperframes",
        homepage: "https://hyperframes.heygen.com",
        items: Array.from({ length: 1_025 }, (_, index) => ({ name: `b-${index}`, type: "hyperframes:block" })),
      },
    }));
    const tooMany = await many.list({});
    expect(tooMany.source).toBe("bundled");
    expect(tooMany.items.map((item) => item.name)).toEqual(["title-card"]);

    const mixed = catalogFor(await cacheRoot(), fakeRegistry({
      names: ["good-block", "bad-block"],
      manifests: { "bad-block": { name: "bad-block", type: "hyperframes:example" } },
    }), { bundled: [] });
    const listing = await mixed.list({});
    expect(listing.source).toBe("network");
    expect(listing.items.map((item) => item.name)).toEqual(["good-block"]);
  });

  it("applies the kind filter before text and matches tags and queries", async () => {
    const registry = fakeRegistry({ names: ["lower-third", "wipe-left"] });
    const catalog = catalogFor(await cacheRoot(), registry, {
      bundled: [bundledItem("title-card")],
    });
    await catalog.list({});
    const blocks = await catalog.list({ kind: "block" });
    expect(blocks.items.every((item) => item.kind === "block")).toBe(true);
    const tagged = await catalog.list({ tags: ["social"] });
    expect(tagged.items).toHaveLength(2);
    const queried = await catalog.list({ query: "WIPE" });
    expect(queried.items.map((item) => item.name)).toEqual(["wipe-left"]);
    const missing = await catalog.list({ category: "Nothing" });
    expect(missing.items).toEqual([]);
  });

  it("publishes the cache atomically and leaves no temporary file behind", async () => {
    const root = await cacheRoot();
    const catalog = catalogFor(root, fakeRegistry());
    await catalog.list({});
    const entries = await readdir(root);
    expect(entries.filter((name) => name.includes("tmp"))).toEqual([]);
    const meta = JSON.parse(await readFile(path.join(root, "meta.json"), "utf8")) as {
      revision: string;
      fetchedAt: number;
      etag: string | null;
    };
    expect(meta.revision).toBe(COMMIT);
    expect(meta.fetchedAt).toBe(Date.parse("2026-08-11T00:00:00Z"));
    expect(meta.etag).toBeNull();
  });

  it("refuses a rewritten cache instead of listing items that fail the contract", async () => {
    const root = await cacheRoot();
    const registry = fakeRegistry();
    const catalog = catalogFor(root, registry, { bundled: [] });
    await catalog.list({});
    expect(registry.urls).toHaveLength(4);

    // Anything on the machine can rewrite this file, and the install flow reads
    // names from the listing, so a tampered entry must invalidate the cache.
    const manifestPath = path.join(root, "manifest.json");
    const cached = JSON.parse(await readFile(manifestPath, "utf8")) as {
      items: { name: string; entry: string }[];
    };
    cached.items[0]!.entry = "../../../etc/passwd";
    await writeFile(manifestPath, JSON.stringify(cached), "utf8");

    const reread = catalogFor(root, registry, { bundled: [] });
    const listing = await reread.list({});
    // Cache discarded, so this call refetched instead of trusting the file.
    expect(registry.urls.length).toBeGreaterThan(4);
    expect(listing.source).toBe("network");
    expect(listing.items.every((item) => !item.entry.includes(".."))).toBe(true);
  });
});
