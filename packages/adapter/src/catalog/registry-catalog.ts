import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { ErrorCode, type DomainError, type RelPath } from "@vidcom/contracts";
import {
  err,
  ok,
  type AbsolutePath,
  type CatalogDependencyNode,
  type CatalogItem,
  type CatalogListFilter,
  type CatalogListing,
  type CatalogMaterializedFile,
  type Result,
  type VerifiedCatalogItem,
  validateCatalogItem,
} from "@vidcom/core";

import { isPublicAddress } from "../net/public-address";
import { catalogManifestDigest } from "./bundled-catalog";
import { canonicalizeCatalogTarget, normalizeUpstreamCatalogItem } from "./normalize";
import {
  CATALOG_PACKAGE_LIMITS,
  CatalogPackageCache,
  CatalogPayloadError,
  catalogPackageKey,
  hashStagedFile,
  writeStagedPayload,
  type CatalogPayloadFailureCode,
  type CatalogPackageLimits,
} from "./package-cache";

/** One materialized package: verified metadata plus staged file capabilities. */
export interface MaterializedCatalogPackage {
  item: VerifiedCatalogItem;
  files: CatalogMaterializedFile[];
  /** Releases the cache pin; callers must run it in a `finally`. */
  release(): Promise<void>;
}

/** Text targets are decoded as UTF-8 by the install path; everything else is bytes. */
function isTextTarget(target: string): "utf8" | "binary" {
  return /\.(html|css|js|mjs|json|svg|txt|md)$/iu.test(target) ? "utf8" : "binary";
}

/** Payload failures mapped into the shared error vocabulary once, here. */
const PAYLOAD_ERROR_CODES: Record<CatalogPayloadFailureCode, ErrorCode> = {
  not_found: ErrorCode.NotFound,
  version_mismatch: ErrorCode.WriteConflict,
  too_large: ErrorCode.TooLarge,
  aborted: ErrorCode.DownloadUnavailable,
  unavailable: ErrorCode.DownloadUnavailable,
  integrity_mismatch: ErrorCode.IntegrityMismatch,
};

/**
 * HyperFrames registry listing with a bounded, offline-tolerant cache
 * (Design §5.16).
 *
 * Two rules shape everything here. Snapshots are immutable: `main` is resolved
 * once to a commit through the GitHub API and every later request carries that
 * exact commit, so the same listing always describes the same bytes. And opening
 * the catalog is metadata only: index plus item manifests, never a package
 * payload, so browsing cannot fill the cache with items nobody selected.
 */

const UPSTREAM_OWNER_REPO = "heygen-com/hyperframes";
const COMMIT_URL = `https://api.github.com/repos/${UPSTREAM_OWNER_REPO}/commits/main`;
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM_OWNER_REPO}`;

/** The only hosts this client may contact; never a URL taken from a payload. */
export const CATALOG_REGISTRY_HOSTS: ReadonlySet<string> = Object.freeze(new Set([
  "api.github.com",
  "raw.githubusercontent.com",
]));

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_ITEMS = 1_024;
const MAX_REDIRECTS = 3;
const MAX_MANIFEST_CONCURRENCY = 8;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const CATALOG_CACHE_MANIFEST_FILE = "manifest.json";
export const CATALOG_CACHE_META_FILE = "meta.json";

/** Expected registry failure; carries a domain code for the route mapping. */
export class CatalogRegistryError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = ErrorCode.DownloadUnavailable,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CatalogRegistryError";
  }
}

export interface CatalogHttpOptions {
  fetch?: typeof globalThis.fetch;
  /** Resolves hostnames for the public-network guard; injected by tests. */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
}

export interface RegistryCatalogOptions {
  /** `<app-data>/cache/catalog`. */
  cacheRoot: string;
  /** Frozen bundled items, always listed and always offline-available. */
  bundled: () => Promise<readonly CatalogItem[]>;
  /** `<catalogAssetRoot>/files`; required to materialize a bundled package. */
  bundledFilesRoot?: string;
  now?: () => number;
  http?: CatalogHttpOptions;
  /** Test seam for the byte ceilings; production uses the exact Design values. */
  limits?: Partial<CatalogPackageLimits>;
}

interface CachedSnapshot {
  revision: string;
  committedAt: string | null;
  items: CatalogItem[];
  fetchedAt: number;
  /** Observed on the commit-resolve response; see `#writeCache`. */
  etag: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects when the signal aborts, so a hung transport cannot outlive a caller. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new CatalogRegistryError("catalog registry request was aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new CatalogRegistryError("catalog registry request was aborted")),
      { once: true },
    );
  });
}

export class HyperframesRegistryCatalog {
  readonly #cacheRoot: string;
  readonly #bundled: RegistryCatalogOptions["bundled"];
  readonly #bundledFilesRoot: string | null;
  readonly #packages: CatalogPackageCache;
  readonly #now: () => number;
  readonly #http: CatalogHttpOptions;
  /** Single-flight refresh, so concurrent callers make one network pass. */
  #inflight: Promise<CachedSnapshot> | null = null;
  #background: Promise<unknown> | null = null;
  #retryAfter = 0;

  constructor(options: RegistryCatalogOptions) {
    this.#cacheRoot = options.cacheRoot;
    this.#bundled = options.bundled;
    this.#bundledFilesRoot = options.bundledFilesRoot ?? null;
    this.#now = options.now ?? (() => Date.now());
    this.#http = options.http ?? {};
    this.#packages = new CatalogPackageCache({
      root: options.cacheRoot,
      limits: { ...CATALOG_PACKAGE_LIMITS, ...options.limits },
      now: this.#now,
    });
  }

  /** Packages currently pinned by a caller; zero when nothing is in flight. */
  pinnedPackageCount(): number {
    return this.#packages.pinnedCount();
  }

  /**
   * Downloads and verifies one package plus its dependency closure.
   *
   * Only called when the author is about to install, so browsing never fills the
   * cache. The result carries staged capabilities and a `release` the caller must
   * run in a `finally`: `prepare` releases before it returns to await approval,
   * while `execute` holds the pin until its mutation settles.
   */
  async materialize(
    name: string,
    version: string,
    signal: AbortSignal,
  ): Promise<Result<MaterializedCatalogPackage, DomainError>> {
    try {
      const bundled = (await this.#bundled()).find((item) => item.name === name);
      if (bundled) {
        if (bundled.version !== version) {
          throw new CatalogPayloadError("version_mismatch", "bundled catalog version does not match");
        }
        return ok(await this.#materializeBundled(bundled));
      }
      return ok(await this.#materializeRemote(name, version, signal));
    } catch (error) {
      const failure = error instanceof CatalogPayloadError
        ? error
        : new CatalogPayloadError("unavailable", "catalog package could not be materialized", { cause: error });
      // The payload code travels in `details.reason`, so an integrity failure is
      // never presented as "offline" by anything downstream.
      return err({
        code: PAYLOAD_ERROR_CODES[failure.code],
        message: failure.message,
        details: { reason: failure.code },
      });
    }
  }

  /** Bundled bytes are already verified in the source tree; no network at all. */
  async #materializeBundled(item: CatalogItem): Promise<MaterializedCatalogPackage> {
    if (this.#bundledFilesRoot === null) {
      throw new CatalogPayloadError("unavailable", "bundled catalog files root is not configured");
    }
    if (item.integrity === null) {
      throw new CatalogPayloadError("integrity_mismatch", "bundled catalog item has no digests");
    }
    const files: CatalogMaterializedFile[] = [];
    for (const [target, digest] of Object.entries(item.integrity.files)) {
      const sourcePath = path.join(this.#bundledFilesRoot, target);
      const actual = await hashStagedFile(sourcePath);
      if (actual === null) {
        throw new CatalogPayloadError("not_found", `bundled catalog file ${target} is missing`);
      }
      if (actual !== `sha256:${digest}`) {
        throw new CatalogPayloadError("integrity_mismatch", `bundled catalog file ${target} does not match its digest`);
      }
      files.push({
        path: target as RelPath,
        contentHash: actual,
        source: { sourcePath: sourcePath as AbsolutePath, contentHash: actual },
        encoding: isTextTarget(target) ? "utf8" : "binary",
      });
    }
    return {
      item: item as VerifiedCatalogItem,
      files,
      release: async () => { /* frozen source bytes are never reclaimed */ },
    };
  }

  async #materializeRemote(
    name: string,
    version: string,
    signal: AbortSignal,
  ): Promise<MaterializedCatalogPackage> {
    const parsed = /^git:([0-9a-f]{40})$/.exec(version);
    if (!parsed) throw new CatalogPayloadError("version_mismatch", "catalog version is not a pinned commit");
    const revision = parsed[1]!;
    const snapshot = await this.#snapshotFor(revision, signal);
    const item = snapshot.items.find((candidate) => candidate.name === name);
    if (!item) throw new CatalogPayloadError("not_found", `catalog item ${name} is not in the snapshot`);
    if (item.source.revision !== revision) {
      throw new CatalogPayloadError("version_mismatch", "catalog item does not belong to the requested commit");
    }

    const limits = this.#packages.limits;
    const key = catalogPackageKey(name, version);
    // A published package is answered with zero network: its metadata and every
    // digest were already verified when it was published.
    const cached = await this.#openPublished(key, item);
    if (cached) return cached;

    if (item.dependencies.length + 1 > limits.closureItems) {
      throw new CatalogPayloadError("too_large", "catalog dependency closure has too many items");
    }
    const closure = [...item.dependencies, name];
    const manifests = await this.#closureManifests(closure, revision, signal);
    const planned: { target: RelPath; url: URL }[] = [];
    for (const member of closure) {
      const manifest = manifests.get(member);
      if (!manifest) throw new CatalogPayloadError("not_found", `catalog dependency ${member} is missing`);
      for (const file of manifest.files) {
        planned.push({ target: file.target, url: file.url });
      }
    }
    if (planned.length > limits.files) {
      throw new CatalogPayloadError("too_large", "catalog package declares too many files");
    }
    const targets = new Set(planned.map(({ target }) => target));
    if (targets.size !== planned.length) {
      throw new CatalogPayloadError("integrity_mismatch", "catalog package declares two files with one target");
    }

    const staged = await this.#packages.stage();
    let total = 0;
    const digests: Record<string, string> = {};
    try {
      for (const file of planned) {
        if (signal.aborted) throw new CatalogPayloadError("aborted", "catalog materialization was aborted");
        const remaining = Math.min(limits.fileBytes, limits.packageBytes - total);
        const response = await this.#payloadResponse(file.url, signal);
        const written = await writeStagedPayload(
          response,
          path.join(staged.root, "files", file.target),
          remaining,
          signal,
        );
        total += written.bytes;
        if (total > limits.packageBytes) {
          throw new CatalogPayloadError("too_large", "catalog package exceeds its byte limit");
        }
        digests[file.target] = written.contentHash.slice("sha256:".length);
      }
      const verified: VerifiedCatalogItem = {
        ...item,
        integrity: {
          algo: "sha256",
          files: digests as VerifiedCatalogItem["integrity"]["files"],
          manifest: "",
        },
        materialization: "verified",
      };
      verified.integrity.manifest = catalogManifestDigest(verified);
      await writeFile(
        path.join(staged.root, "package.json"),
        `${JSON.stringify(verified)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await this.#packages.publish(key, staged.root);
    } catch (error) {
      await staged.discard();
      throw error;
    }
    const opened = await this.#openPublished(key, item);
    if (!opened) throw new CatalogPayloadError("unavailable", "catalog package disappeared after publication");
    await this.#packages.enforceBudget();
    return opened;
  }

  /** Opens an already-published package, re-verifying every digest first. */
  async #openPublished(
    key: string,
    item: CatalogItem,
  ): Promise<MaterializedCatalogPackage | null> {
    const root = this.#packages.packageRoot(key);
    let verified: VerifiedCatalogItem;
    try {
      verified = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as VerifiedCatalogItem;
    } catch {
      return null;
    }
    if (verified.name !== item.name || verified.version !== item.version) return null;
    const release = this.#packages.pin(key);
    try {
      const files: CatalogMaterializedFile[] = [];
      for (const [target, digest] of Object.entries(verified.integrity.files)) {
        const sourcePath = path.join(root, "files", target);
        const actual = await hashStagedFile(sourcePath);
        if (actual !== `sha256:${digest}`) {
          throw new CatalogPayloadError("integrity_mismatch", `catalog file ${target} does not match its digest`);
        }
        files.push({
          path: target as RelPath,
          contentHash: actual,
          source: { sourcePath: sourcePath as AbsolutePath, contentHash: actual },
          encoding: isTextTarget(target) ? "utf8" : "binary",
        });
      }
      if (catalogManifestDigest(verified) !== verified.integrity.manifest) {
        throw new CatalogPayloadError("integrity_mismatch", "catalog package manifest digest does not match");
      }
      await this.#packages.touch(key);
      return { item: verified, files, release };
    } catch (error) {
      await release();
      if (error instanceof CatalogPayloadError) throw error;
      return null;
    }
  }

  /** Returns the snapshot for an exact commit, refreshing only if needed. */
  async #snapshotFor(revision: string, signal: AbortSignal): Promise<CachedSnapshot> {
    const cached = await this.#readCache();
    if (cached?.revision === revision) return cached;
    const refreshed = await this.#refresh();
    if (refreshed.revision !== revision) {
      throw new CatalogPayloadError("version_mismatch", "the registry no longer serves the requested commit");
    }
    if (signal.aborted) throw new CatalogPayloadError("aborted", "catalog materialization was aborted");
    return refreshed;
  }

  /** Re-reads the closure manifests at the pinned commit to plan exact targets. */
  async #closureManifests(
    closure: readonly string[],
    revision: string,
    signal: AbortSignal,
  ): Promise<Map<string, { files: { target: RelPath; url: URL }[] }>> {
    const manifests = new Map<string, { files: { target: RelPath; url: URL }[] }>();
    for (const member of closure) {
      if (signal.aborted) throw new CatalogPayloadError("aborted", "catalog materialization was aborted");
      let raw: unknown;
      let directory = "blocks";
      for (const candidate of ["blocks", "components"]) {
        try {
          raw = await this.fetchJson(
            new URL(`${RAW_BASE}/${revision}/registry/${candidate}/${member}/registry-item.json`),
            MAX_MANIFEST_BYTES,
            signal,
          );
          directory = candidate;
          break;
        } catch { raw = undefined; }
      }
      if (!isRecord(raw) || !Array.isArray(raw.files)) {
        throw new CatalogPayloadError("not_found", `catalog manifest for ${member} is unavailable`);
      }
      const files: { target: RelPath; url: URL }[] = [];
      for (const file of raw.files) {
        if (!isRecord(file) || typeof file.target !== "string" || typeof file.path !== "string") {
          throw new CatalogPayloadError("integrity_mismatch", `catalog manifest for ${member} is invalid`);
        }
        const target = canonicalizeCatalogTarget(file.target);
        if (target === null) {
          throw new CatalogPayloadError("integrity_mismatch", `catalog manifest for ${member} has an unsafe target`);
        }
        const source = canonicalizeCatalogTarget(file.path);
        if (source === null) {
          throw new CatalogPayloadError("integrity_mismatch", `catalog manifest for ${member} has an unsafe path`);
        }
        files.push({
          target,
          url: new URL(`${RAW_BASE}/${revision}/registry/${directory}/${member}/${source}`),
        });
      }
      manifests.set(member, { files });
    }
    return manifests;
  }

  /** One bounded payload request; shares the transport policy with metadata. */
  async #payloadResponse(url: URL, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#http.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    let target = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await this.#assertReachable(target);
      const doFetch = this.#http.fetch ?? globalThis.fetch;
      const response = await Promise.race([
        doFetch(target, { signal: combined, redirect: "manual" }),
        abortRejection(combined),
      ]);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects === MAX_REDIRECTS) {
          throw new CatalogPayloadError("unavailable", "catalog payload redirected too many times");
        }
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CatalogPayloadError("not_found", `catalog payload request failed with HTTP ${response.status}`);
      }
      return response;
    }
    throw new CatalogPayloadError("unavailable", "catalog payload redirected too many times");
  }

  /**
   * Lists bundled plus registry items.
   *
   * Bundled items are always included: they are the only source of curated
   * templates, so hiding them whenever the registry answers would make templates
   * disappear exactly when the app is online. `source` describes where the
   * registry portion came from.
   */
  async list(filter: CatalogListFilter): Promise<CatalogListing> {
    const bundled = [...await this.#bundled()];
    const cached = await this.#readCache();
    const now = this.#now();

    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return { items: applyCatalogFilter([...bundled, ...cached.items], filter), source: "cache", stale: false };
    }
    if (cached) {
      // Stale-while-revalidate: answer from disk now, refresh without blocking.
      this.#refreshInBackground();
      return { items: applyCatalogFilter([...bundled, ...cached.items], filter), source: "cache", stale: true };
    }
    if (now < this.#retryAfter) {
      return { items: applyCatalogFilter(bundled, filter), source: "bundled", stale: false };
    }
    try {
      const refreshed = await this.#refresh();
      return {
        items: applyCatalogFilter([...bundled, ...refreshed.items], filter),
        source: "network",
        stale: false,
      };
    } catch {
      // A failure is remembered for a minute only, so a transient outage does not
      // pin the catalog to bundled content for the rest of the session.
      this.#retryAfter = this.#now() + NEGATIVE_TTL_MS;
      return { items: applyCatalogFilter(bundled, filter), source: "bundled", stale: false };
    }
  }

  /** Awaits any background refresh; production callers never need to. */
  async whenIdle(): Promise<void> {
    await this.#background?.catch(() => undefined);
  }

  /**
   * One bounded registry request.
   *
   * Public because it is the single transport seam every registry read shares,
   * and its policy — HTTPS, host allowlist, public address, bounded body,
   * caller-owned cancellation — is what the security tests must exercise.
   */
  async fetchJson(url: URL, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
    return (await this.#request(url, maxBytes, signal)).body;
  }

  async #request(
    url: URL,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ body: unknown; etag: string | null }> {
    const timeout = AbortSignal.timeout(this.#http.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let target = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await this.#assertReachable(target);
      const doFetch = this.#http.fetch ?? globalThis.fetch;
      const response = await Promise.race([
        doFetch(target, { signal: combined, redirect: "manual", headers: { Accept: "application/json" } }),
        abortRejection(combined),
      ]);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects === MAX_REDIRECTS) {
          throw new CatalogRegistryError("catalog registry redirected too many times");
        }
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CatalogRegistryError(`catalog registry request failed with HTTP ${response.status}`);
      }
      return await this.#readBoundedJson(response, maxBytes, combined)
        .then((body) => ({ body, etag: response.headers.get("etag") }));
    }
    throw new CatalogRegistryError("catalog registry redirected too many times");
  }

  async #assertReachable(url: URL): Promise<void> {
    if (url.protocol !== "https:") {
      throw new CatalogRegistryError("catalog registry requires HTTPS");
    }
    if (url.username || url.password) {
      throw new CatalogRegistryError("catalog registry URL must not carry credentials");
    }
    if (!CATALOG_REGISTRY_HOSTS.has(url.hostname)) {
      throw new CatalogRegistryError(`catalog registry host ${url.hostname} is not in the allowlist`);
    }
    const addresses = await (this.#http.resolveHost ?? defaultResolveHost)(url.hostname);
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
      throw new CatalogRegistryError("catalog registry host resolved to a non-public address");
    }
  }

  async #readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new CatalogRegistryError("catalog registry response is too large", ErrorCode.TooLarge);
    }
    if (!response.body) throw new CatalogRegistryError("catalog registry returned an empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), abortRejection(signal)]);
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new CatalogRegistryError("catalog registry response is too large", ErrorCode.TooLarge);
        }
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error instanceof CatalogRegistryError
        ? error
        : new CatalogRegistryError("catalog registry response could not be read", ErrorCode.DownloadUnavailable, { cause: error });
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      throw new CatalogRegistryError("catalog registry returned invalid JSON", ErrorCode.DownloadUnavailable, { cause: error });
    }
  }

  #refreshInBackground(): void {
    if (this.#background) return;
    this.#background = this.#refresh()
      .catch(() => undefined)
      .finally(() => { this.#background = null; });
  }

  #refresh(): Promise<CachedSnapshot> {
    this.#inflight ??= this.#refreshOnce().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #refreshOnce(): Promise<CachedSnapshot> {
    const head = await this.#request(new URL(COMMIT_URL), MAX_MANIFEST_BYTES);
    const resolved = head.body;
    const revision = isRecord(resolved) && typeof resolved.sha === "string" ? resolved.sha.toLowerCase() : "";
    if (!COMMIT_PATTERN.test(revision)) {
      throw new CatalogRegistryError("catalog registry did not resolve a commit for the default branch");
    }
    const committedAt = isRecord(resolved) && isRecord(resolved.commit) && isRecord(resolved.commit.committer)
      && typeof resolved.commit.committer.date === "string"
      ? resolved.commit.committer.date
      : null;

    const index = await this.fetchJson(
      new URL(`${RAW_BASE}/${revision}/registry/registry.json`),
      MAX_INDEX_BYTES,
    );
    if (!isRecord(index) || !Array.isArray(index.items)) {
      throw new CatalogRegistryError("catalog registry index is invalid");
    }
    if (index.items.length > MAX_INDEX_ITEMS) {
      throw new CatalogRegistryError("catalog registry index declares too many items", ErrorCode.TooLarge);
    }
    const entries = index.items.flatMap((entry) => (
      isRecord(entry) && typeof entry.name === "string" && typeof entry.type === "string"
        ? [{ name: entry.name, type: entry.type }]
        : []
    ));

    // Only blocks are visible from the network; a component is reachable as a
    // dependency and an example is a whole-project scaffold.
    const blocks = entries.filter((entry) => entry.type === "hyperframes:block");
    const manifests = new Map<string, unknown>();
    await this.#pooled(entries, async (entry) => {
      const url = new URL(`${RAW_BASE}/${revision}/registry/${directoryFor(entry.type)}/${entry.name}/registry-item.json`);
      try {
        manifests.set(entry.name, await this.fetchJson(url, MAX_MANIFEST_BYTES));
      } catch {
        manifests.set(entry.name, null);
      }
    });

    const lookup = (name: string): CatalogDependencyNode | undefined => {
      const manifest = manifests.get(name);
      if (!isRecord(manifest) || typeof manifest.type !== "string") return undefined;
      const kind = manifest.type.startsWith("hyperframes:")
        ? manifest.type.slice("hyperframes:".length)
        : "";
      if (kind !== "block" && kind !== "component" && kind !== "example") return undefined;
      const dependencies = Array.isArray(manifest.registryDependencies)
        ? manifest.registryDependencies.filter((value): value is string => typeof value === "string")
        : [];
      return { dependencies, kind };
    };

    const items: CatalogItem[] = [];
    for (const entry of blocks) {
      const normalized = normalizeUpstreamCatalogItem({
        entry,
        manifest: manifests.get(entry.name),
        revision,
        committedAt,
        lookup,
      });
      // A rejected item is dropped with its diagnostics rather than failing the
      // whole listing: one bad upstream manifest must not hide the registry.
      if (normalized.ok) items.push(normalized.item);
    }

    const snapshot: CachedSnapshot = {
      revision,
      committedAt,
      items,
      fetchedAt: this.#now(),
      etag: head.etag,
    };
    await this.#writeCache(snapshot);
    this.#retryAfter = 0;
    return snapshot;
  }

  /** Runs a bounded number of requests at a time. */
  async #pooled<T>(inputs: readonly T[], run: (input: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MAX_MANIFEST_CONCURRENCY, inputs.length) },
      async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= inputs.length) return;
          await run(inputs[index]!);
        }
      },
    );
    await Promise.all(workers);
  }

  async #readCache(): Promise<CachedSnapshot | null> {
    try {
      const [manifestText, metaText] = await Promise.all([
        readFile(path.join(this.#cacheRoot, CATALOG_CACHE_MANIFEST_FILE), "utf8"),
        readFile(path.join(this.#cacheRoot, CATALOG_CACHE_META_FILE), "utf8"),
      ]);
      const manifest = JSON.parse(manifestText) as unknown;
      const meta = JSON.parse(metaText) as unknown;
      if (!isRecord(manifest) || !Array.isArray(manifest.items)) return null;
      if (!isRecord(meta) || typeof meta.fetchedAt !== "number") return null;
      // Cached items are re-validated against the same contract the network path
      // uses. The cache is local, but it is still a file anything on the machine
      // can rewrite, and a listing is what the install flow reads names from.
      const items: CatalogItem[] = [];
      for (const candidate of manifest.items) {
        if (!isRecord(candidate)) return null;
        const item = candidate as unknown as CatalogItem;
        if (validateCatalogItem(item).length > 0) return null;
        items.push(item);
      }
      return {
        revision: typeof manifest.revision === "string" ? manifest.revision : "",
        committedAt: typeof manifest.committedAt === "string" ? manifest.committedAt : null,
        items,
        fetchedAt: meta.fetchedAt,
        etag: typeof meta.etag === "string" ? meta.etag : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Writes both files through a sibling temp plus rename, never in place.
   *
   * The stored ETag is the one observed while resolving the default branch. It is
   * recorded for diagnostics rather than used for conditional revalidation: the
   * resolved commit is itself the cache identity, so a moved head necessarily
   * produces a different snapshot and a 304 would tell us nothing extra.
   */
  async #writeCache(snapshot: CachedSnapshot): Promise<void> {
    await mkdir(this.#cacheRoot, { recursive: true });
    await this.#publish(CATALOG_CACHE_MANIFEST_FILE, {
      revision: snapshot.revision,
      committedAt: snapshot.committedAt,
      items: snapshot.items,
    });
    await this.#publish(CATALOG_CACHE_META_FILE, {
      fetchedAt: snapshot.fetchedAt,
      etag: snapshot.etag,
      revision: snapshot.revision,
    });
  }

  async #publish(name: string, body: unknown): Promise<void> {
    const target = path.join(this.#cacheRoot, name);
    const temporary = path.join(this.#cacheRoot, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function directoryFor(type: string): string {
  if (type === "hyperframes:example") return "examples";
  if (type === "hyperframes:component") return "components";
  return "blocks";
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import("node:dns/promises");
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  } catch (error) {
    throw new CatalogRegistryError(
      "catalog registry hostname could not be resolved",
      ErrorCode.DownloadUnavailable,
      { cause: error },
    );
  }
}

/** Applies the listing filter: kind first, then category, tags and free text. */
export function applyCatalogFilter(
  items: readonly CatalogItem[],
  filter: CatalogListFilter,
): CatalogItem[] {
  const query = filter.query?.trim().toLowerCase();
  const tags = filter.tags?.map((tag) => tag.normalize("NFC").toLowerCase());
  return items.filter((item) => {
    if (filter.kind !== undefined && item.kind !== filter.kind) return false;
    if (filter.category !== undefined && item.category !== filter.category) return false;
    if (tags && tags.length > 0) {
      const own = item.tags.map((tag) => tag.toLowerCase());
      if (!tags.every((tag) => own.includes(tag))) return false;
    }
    if (query) {
      const haystack = `${item.name} ${item.title} ${item.description ?? ""} ${item.tags.join(" ")}`
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
