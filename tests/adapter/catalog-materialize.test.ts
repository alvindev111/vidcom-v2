import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CATALOG_PACKAGE_LIMITS,
  HyperframesRegistryCatalog,
  loadBundledCatalog,
  type CatalogHttpOptions,
} from "@vidcom/adapter";
import { type CatalogItem } from "@vidcom/core";

const COMMIT = "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c";
const COMMITTED_AT = "2026-08-10T10:00:00Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-catalog-pkg-"));
  roots.push(root);
  return root;
}

interface FakeFile {
  target: string;
  type: string;
  body: string;
  /** Lies about the size to prove real bytes are counted, not the header. */
  contentLength?: number;
}

interface FakeItem {
  type?: string;
  dependencies?: string[];
  files: FakeFile[];
}

function registry(items: Record<string, FakeItem>, options: { delayMs?: number } = {}) {
  const urls: string[] = [];
  const fetch = (async (input: URL | string) => {
    const url = String(input);
    urls.push(url);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (url.endsWith("/commits/main")) {
      return Response.json({ sha: COMMIT, commit: { committer: { date: COMMITTED_AT } } });
    }
    if (url.endsWith("/registry.json")) {
      return Response.json({
        name: "hyperframes",
        homepage: "https://hyperframes.heygen.com",
        items: Object.entries(items).map(([name, item]) => ({
          name,
          type: item.type ?? "hyperframes:block",
        })),
      });
    }
    for (const [name, item] of Object.entries(items)) {
      const directory = (item.type ?? "hyperframes:block") === "hyperframes:component"
        ? "components"
        : "blocks";
      if (url.endsWith(`/registry/${directory}/${name}/registry-item.json`)) {
        return Response.json({
          name,
          type: item.type ?? "hyperframes:block",
          title: `Block ${name}`,
          description: `${name} description`,
          tags: ["social"],
          dimensions: { width: 1920, height: 1080 },
          duration: 4,
          registryDependencies: item.dependencies ?? [],
          files: item.files.map((file) => ({
            path: path.posix.basename(file.target),
            target: file.target,
            type: file.type,
          })),
        });
      }
      for (const file of item.files) {
        if (url.endsWith(`/${COMMIT}/registry/${directory}/${name}/${path.posix.basename(file.target)}`)) {
          const headers = new Headers({ "content-type": "text/plain" });
          if (file.contentLength !== undefined) {
            headers.set("content-length", String(file.contentLength));
          }
          return new Response(file.body, { headers });
        }
      }
    }
    return new Response("not found", { status: 404 });
  }) as NonNullable<CatalogHttpOptions["fetch"]>;
  return { fetch, urls };
}

function block(name: string, dependencies: string[] = []): FakeItem {
  return {
    dependencies,
    files: [
      { target: `blocks/${name}/index.html`, type: "hyperframes:composition", body: `<section>${name}</section>` },
      { target: `blocks/${name}/style.css`, type: "hyperframes:style", body: `.${name} { color: red }` },
    ],
  };
}

function component(name: string): FakeItem {
  return {
    type: "hyperframes:component",
    files: [{ target: `components/${name}/effect.css`, type: "hyperframes:style", body: `.${name} {}` }],
  };
}

function catalogFor(
  root: string,
  fake: { fetch: NonNullable<CatalogHttpOptions["fetch"]> },
  overrides: {
    limits?: Partial<Record<keyof typeof CATALOG_PACKAGE_LIMITS, number>>;
    bundled?: CatalogItem[];
    now?: () => number;
  } = {},
): HyperframesRegistryCatalog {
  return new HyperframesRegistryCatalog({
    cacheRoot: root,
    bundled: async () => overrides.bundled ?? [],
    now: overrides.now ?? (() => Date.parse("2026-08-11T00:00:00Z")),
    http: { fetch: fake.fetch, resolveHost: async () => ["8.8.8.8"] },
    limits: overrides.limits,
  });
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

describe("catalog payload materialization", () => {
  it("publishes the exact closure as verified staged sources without buffering bytes", async () => {
    const root = await cacheRoot();
    const fake = registry({
      "lower-third": block("lower-third", ["text-fx"]),
      "text-fx": component("text-fx"),
      "unrelated": block("unrelated"),
    });
    const catalog = catalogFor(root, fake);
    await catalog.list({});
    const listUrls = fake.urls.length;

    const materialized = await catalog.materialize("lower-third", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    try {
      const { item, files } = materialized.value;
      expect(item.materialization).toBe("verified");
      expect(item.integrity).not.toBeNull();
      expect(Object.keys(item.integrity.files).sort()).toEqual([
        "blocks/lower-third/index.html",
        "blocks/lower-third/style.css",
        "components/text-fx/effect.css",
      ]);
      expect(item.integrity.manifest).toMatch(/^[0-9a-f]{64}$/u);
      expect(files.map((file) => file.path).sort()).toEqual(Object.keys(item.integrity.files).sort());
      for (const file of files) {
        expect(path.isAbsolute(file.source.sourcePath)).toBe(true);
        expect(file.source.contentHash).toBe(file.contentHash);
        expect(file.contentHash).toBe(`sha256:${item.integrity.files[file.path]}`);
        // A capability, never bytes: the file is readable from app-data.
        expect((await readFile(file.source.sourcePath, "utf8")).length).toBeGreaterThan(0);
      }
      // Only the selected closure was downloaded; the unrelated block was not.
      const payloadUrls = fake.urls.slice(listUrls).filter((url) => !url.endsWith("registry-item.json"));
      expect(payloadUrls).toHaveLength(3);
      expect(payloadUrls.every((url) => url.includes(`/${COMMIT}/`))).toBe(true);
      expect(payloadUrls.some((url) => url.includes("unrelated"))).toBe(false);
    } finally {
      await materialized.value.release();
    }
  });

  it("serves a published package from cache and refuses a version it did not publish", async () => {
    const root = await cacheRoot();
    const fake = registry({ "lower-third": block("lower-third") });
    const catalog = catalogFor(root, fake);
    await catalog.list({});
    const first = await catalog.materialize("lower-third", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(first.ok).toBe(true);
    if (first.ok) await first.value.release();
    const afterFirst = fake.urls.length;

    const second = await catalog.materialize("lower-third", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.item.integrity.manifest).toBe(
        first.ok ? first.value.item.integrity.manifest : "",
      );
      await second.value.release();
    }
    expect(fake.urls).toHaveLength(afterFirst);

    const other = "0".repeat(40);
    const mismatch = await catalog.materialize("lower-third", `git:${other}`, AbortSignal.timeout(5_000));
    expect(mismatch.ok).toBe(false);
    const unknown = await catalog.materialize("nope", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(unknown.ok).toBe(false);
  });

  it("counts real bytes and publishes nothing when any bound is exceeded", async () => {
    expect(CATALOG_PACKAGE_LIMITS).toEqual({
      closureItems: 256,
      files: 1_024,
      fileBytes: 25 * 1024 * 1024,
      packageBytes: 250 * 1024 * 1024,
      cacheBytes: 1024 * 1024 * 1024,
    });

    const root = await cacheRoot();
    // The response understates its size by two orders of magnitude.
    const fake = registry({
      "fat-block": {
        files: [{
          target: "blocks/fat-block/index.html",
          type: "hyperframes:composition",
          body: "x".repeat(4_096),
          contentLength: 8,
        }],
      },
    });
    const catalog = catalogFor(root, fake, { limits: { fileBytes: 1_024 } });
    await catalog.list({});
    const tooBig = await catalog.materialize("fat-block", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error.code).toBe("too_large");
    expect(await directorySize(path.join(root, "packages"))).toBe(0);

    const wholePackage = catalogFor(await cacheRoot(), registry({
      "two-file": {
        files: [
          { target: "blocks/two-file/index.html", type: "hyperframes:composition", body: "y".repeat(800) },
          { target: "blocks/two-file/style.css", type: "hyperframes:style", body: "z".repeat(800) },
        ],
      },
    }), { limits: { packageBytes: 1_000 } });
    await wholePackage.list({});
    const overPackage = await wholePackage.materialize("two-file", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(overPackage.ok).toBe(false);
    if (!overPackage.ok) expect(overPackage.error.code).toBe("too_large");

    const manyFiles = catalogFor(await cacheRoot(), registry({
      "wide": {
        files: [
          { target: "blocks/wide/index.html", type: "hyperframes:composition", body: "a" },
          { target: "blocks/wide/one.css", type: "hyperframes:style", body: "b" },
          { target: "blocks/wide/two.css", type: "hyperframes:style", body: "c" },
        ],
      },
    }), { limits: { files: 2 } });
    await manyFiles.list({});
    const overFiles = await manyFiles.materialize("wide", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(overFiles.ok).toBe(false);

    const deep = catalogFor(await cacheRoot(), registry({
      "root-block": block("root-block", ["dep-a"]),
      "dep-a": { type: "hyperframes:component", dependencies: ["dep-b"], files: [{ target: "components/dep-a/a.css", type: "hyperframes:style", body: "a" }] },
      "dep-b": component("dep-b"),
    }), { limits: { closureItems: 1 } });
    await deep.list({});
    const overClosure = await deep.materialize("root-block", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(overClosure.ok).toBe(false);
  });

  it("leaves no staging residue when a download fails or is cancelled", async () => {
    const root = await cacheRoot();
    const failing = registry({
      "broken": {
        files: [
          { target: "blocks/broken/index.html", type: "hyperframes:composition", body: "<section/>" },
          { target: "blocks/broken/missing.css", type: "hyperframes:style", body: "" },
        ],
      },
    });
    // Serve the second file as a 404 by asking for a name the fake does not know.
    const catalog = new HyperframesRegistryCatalog({
      cacheRoot: root,
      bundled: async () => [],
      now: () => Date.parse("2026-08-11T00:00:00Z"),
      http: {
        resolveHost: async () => ["8.8.8.8"],
        fetch: (async (input: URL | string, init?: RequestInit) => {
          if (String(input).endsWith("missing.css")) return new Response("gone", { status: 404 });
          return failing.fetch(input as URL, init);
        }) as NonNullable<CatalogHttpOptions["fetch"]>,
      },
    });
    await catalog.list({});
    const failed = await catalog.materialize("broken", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(failed.ok).toBe(false);
    expect(await directorySize(path.join(root, "packages"))).toBe(0);
    expect(await directorySize(path.join(root, "staging"))).toBe(0);

    const cancelRoot = await cacheRoot();
    const slow = catalogFor(cancelRoot, registry({ "slow": block("slow") }, { delayMs: 50 }));
    await slow.list({});
    const controller = new AbortController();
    const pending = slow.materialize("slow", `git:${COMMIT}`, controller.signal);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.ok).toBe(false);
    expect(await directorySize(path.join(cancelRoot, "packages"))).toBe(0);
    expect(await directorySize(path.join(cancelRoot, "staging"))).toBe(0);
  });

  it("evicts the least recently used unpinned package and never a pinned one", async () => {
    const root = await cacheRoot();
    let clock = Date.parse("2026-08-11T00:00:00Z");
    const fake = registry({
      "first": { files: [{ target: "blocks/first/index.html", type: "hyperframes:composition", body: "1".repeat(400) }] },
      "second": { files: [{ target: "blocks/second/index.html", type: "hyperframes:composition", body: "2".repeat(400) }] },
      "third": { files: [{ target: "blocks/third/index.html", type: "hyperframes:composition", body: "3".repeat(400) }] },
    });
    const catalog = catalogFor(root, fake, { limits: { cacheBytes: 3_000 }, now: () => clock });
    await catalog.list({});

    const first = await catalog.materialize("first", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(first.ok).toBe(true);
    if (first.ok) await first.value.release();

    clock += 1_000;
    const second = await catalog.materialize("second", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(second.ok).toBe(true);
    // Pinned while the third package is published, so it must survive eviction.
    clock += 1_000;
    const third = await catalog.materialize("third", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(third.ok).toBe(true);
    if (third.ok) await third.value.release();

    expect(catalog.pinnedPackageCount()).toBe(1);
    if (second.ok) {
      // Still readable through its pin even though the budget was exceeded.
      expect((await readFile(second.value.files[0]!.source.sourcePath, "utf8")).length).toBe(400);
      await second.value.release();
    }
    expect(catalog.pinnedPackageCount()).toBe(0);
    expect(await directorySize(path.join(root, "packages"))).toBeLessThanOrEqual(3_000);
    const survivors = await readdir(path.join(root, "packages"));
    expect(survivors).toHaveLength(2);
  });

  it("counts real bytes across a redirect and never restarts the tally", async () => {
    const root = await cacheRoot();
    const body = "q".repeat(2_048);
    let payloadRequests = 0;
    const catalog = new HyperframesRegistryCatalog({
      cacheRoot: root,
      bundled: async () => [],
      now: () => Date.parse("2026-08-11T00:00:00Z"),
      limits: { fileBytes: 1_024 },
      http: {
        resolveHost: async () => ["8.8.8.8"],
        fetch: (async (input: URL | string, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("index.html")) {
            payloadRequests += 1;
            return payloadRequests === 1
              ? new Response(null, {
                  status: 302,
                  headers: { location: `https://raw.githubusercontent.com/moved/index.html` },
                })
              : new Response(body);
          }
          if (url.endsWith("moved/index.html")) return new Response(body);
          return registry({ "redirected": { files: [{ target: "blocks/redirected/index.html", type: "hyperframes:composition", body }] } })
            .fetch(input as URL, init);
        }) as NonNullable<CatalogHttpOptions["fetch"]>,
      },
    });
    await catalog.list({});
    const result = await catalog.materialize("redirected", `git:${COMMIT}`, AbortSignal.timeout(5_000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("too_large");
    expect(await directorySize(path.join(root, "packages"))).toBe(0);
  });

  it("materializes a bundled package from frozen bytes with no network at all", async () => {
    const bundledRoot = path.resolve("packages/adapter/assets/catalog");
    const loaded = await loadBundledCatalog(bundledRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const item = loaded.value.items[0]!;
    const fake = registry({});
    const catalog = new HyperframesRegistryCatalog({
      cacheRoot: await cacheRoot(),
      bundled: async () => loaded.value.items,
      bundledFilesRoot: path.join(bundledRoot, "files"),
      now: () => Date.parse("2026-08-11T00:00:00Z"),
      http: { fetch: fake.fetch, resolveHost: async () => ["8.8.8.8"] },
    });
    const materialized = await catalog.materialize(item.name, item.version, AbortSignal.timeout(5_000));
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    try {
      expect(fake.urls).toEqual([]);
      expect(materialized.value.item.source.registry).toBe("bundled");
      expect(materialized.value.files.length).toBeGreaterThan(0);
      for (const file of materialized.value.files) {
        expect(file.contentHash).toBe(`sha256:${item.integrity!.files[file.path]}`);
      }
    } finally {
      await materialized.value.release();
    }
  });
});
