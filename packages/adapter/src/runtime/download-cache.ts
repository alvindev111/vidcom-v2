import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { ErrorCode } from "@vidcom/contracts";

import { writeAtomic } from "../fs/atomic-write";
import { AtomicDirectoryLock, type DirectoryLockLease } from "./atomic-directory-lock";
import { RuntimeAssetError } from "./runtime-asset-source";

const PARTIAL_MARKER = ".downloading.json";
const COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/** Production component names whose roots are stable app-data contracts. */
export const DOWNLOAD_CACHE_COMPONENTS = {
  browser: "browser-cache",
  models: "models",
} as const;

export type DownloadCacheState = "missing" | "partial" | "ready";
export type DownloadFailureCode =
  | ErrorCode.DownloadTlsUntrusted
  | ErrorCode.DownloadUnavailable;

export interface DownloadCacheStatus {
  component: string;
  root: string;
  state: DownloadCacheState;
  /** Present only while a download is recorded as in flight. */
  startedAt?: string;
  /** Stable reason left by the most recent coded download failure. */
  failureCode?: DownloadFailureCode;
}

export interface PartialMarker {
  component: string;
  startedAt: string;
  pid: number;
  failureCode?: DownloadFailureCode;
}

export interface DownloadCacheOptions {
  cacheRoot: string;
  clock?: () => Date;
  lockTimeoutMs?: number;
}

function assertComponent(component: string): void {
  if (!COMPONENT_PATTERN.test(component)) {
    throw new RuntimeAssetError(
      ErrorCode.RuntimeManifestInvalid,
      `download cache component ${component} is not a portable directory name`,
      { component },
    );
  }
}

function invalidCachePath(message: string, details: Record<string, unknown>): never {
  throw new RuntimeAssetError(ErrorCode.RuntimeManifestInvalid, message, details);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function failureCode(error: unknown): DownloadFailureCode | undefined {
  if (!(error instanceof RuntimeAssetError)) return undefined;
  if (error.code === ErrorCode.DownloadTlsUntrusted) return ErrorCode.DownloadTlsUntrusted;
  if (error.code === ErrorCode.DownloadUnavailable) return ErrorCode.DownloadUnavailable;
  return undefined;
}

function markerFailureCode(value: unknown): DownloadFailureCode | undefined {
  if (value === ErrorCode.DownloadTlsUntrusted) return ErrorCode.DownloadTlsUntrusted;
  if (value === ErrorCode.DownloadUnavailable) return ErrorCode.DownloadUnavailable;
  return undefined;
}

function assertContained(cacheRoot: string, componentRoot: string, component: string): void {
  const relative = path.relative(cacheRoot, componentRoot);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    invalidCachePath("download cache component escapes its cache root", {
      cacheRoot,
      component,
      componentRoot,
    });
  }
}

/**
 * Owns download caches that are populated at runtime, not extracted at install.
 *
 * Chromium and the Hugging Face model cache are downloads, so unlike a verified
 * archive there is no checksum to compare against — a truncated download looks
 * exactly like a complete one from the outside. Measured on Windows:
 * `hyperframes browser path` prints a path and exits 0 for a 1 MB Chromium that
 * cannot launch. Asking the tool is therefore never proof.
 *
 * The partial marker is the only source of truth. It is written **before** the
 * first byte and removed only after the download reports success, so anything
 * interrupted stays visibly partial across restarts. A per-component lock keeps
 * two processes from downloading the same component into the same directory;
 * separate components stay independent, since one slow model download must not
 * block a browser fetch.
 */
export class DownloadCacheCoordinator {
  private readonly cacheRoot: string;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number | undefined;
  private readonly backgroundSettlements = new Set<Promise<void>>();

  constructor(options: DownloadCacheOptions) {
    if (
      !path.isAbsolute(options.cacheRoot)
      || path.resolve(options.cacheRoot) !== options.cacheRoot
      || path.dirname(options.cacheRoot) === options.cacheRoot
    ) {
      throw new TypeError("download cache root must be a normalized absolute non-root path");
    }
    this.cacheRoot = options.cacheRoot;
    this.clock = options.clock ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  componentRoot(component: string): string {
    assertComponent(component);
    return path.join(this.cacheRoot, component);
  }

  private async inspectCacheRoot(create: boolean): Promise<string | undefined> {
    let metadata;
    try {
      metadata = await lstat(this.cacheRoot);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return undefined;
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      metadata = await lstat(this.cacheRoot);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      invalidCachePath("download cache root must be a real directory", {
        cacheRoot: this.cacheRoot,
      });
    }
    return await realpath(this.cacheRoot);
  }

  private async inspectComponentRoot(
    component: string,
    create: boolean,
  ): Promise<string | undefined> {
    const root = this.componentRoot(component);
    const cacheAuthority = await this.inspectCacheRoot(create);
    if (cacheAuthority === undefined) return undefined;
    if (create) {
      try {
        await mkdir(root, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    let metadata;
    try {
      metadata = await lstat(root);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      invalidCachePath("download cache component must be a real directory", {
        cacheRoot: this.cacheRoot,
        component,
        componentRoot: root,
      });
    }
    assertContained(cacheAuthority, await realpath(root), component);
    return root;
  }

  private async ensureComponentRoot(component: string): Promise<string> {
    const root = await this.inspectComponentRoot(component, true);
    if (root === undefined) {
      invalidCachePath("download cache component directory could not be created", {
        cacheRoot: this.cacheRoot,
        component,
      });
    }
    return root;
  }

  private async writeMarker(root: string, marker: PartialMarker): Promise<void> {
    await writeAtomic(
      path.join(root, PARTIAL_MARKER) as never,
      `${JSON.stringify(marker)}\n`,
    );
  }

  private componentLock(root: string): AtomicDirectoryLock {
    return new AtomicDirectoryLock(`${root}.lock`, {
      ...this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs },
      timeoutCode: ErrorCode.DownloadUnavailable,
    });
  }

  /** Transfers a lease to an observed background finalizer after a prompt timeout. */
  private retainLeaseUntil(settled: Promise<unknown>, lease: DirectoryLockLease): void {
    const finalizer = settled
      .then(() => lease.release())
      // A failed ownership check deliberately leaves the lock in place. Observe
      // the rejection here so a timeout cannot create an unhandled rejection.
      .catch(() => undefined);
    this.backgroundSettlements.add(finalizer);
    void finalizer.finally(() => { this.backgroundSettlements.delete(finalizer); });
  }

  /** Classifies a component without trusting anything the downloaded tool says. */
  async status(component: string): Promise<DownloadCacheStatus> {
    const root = this.componentRoot(component);
    const inspectedRoot = await this.inspectComponentRoot(component, false);
    if (inspectedRoot === undefined) return { component, root, state: "missing" };
    const marker = await this.readMarker(component, inspectedRoot);
    if (marker) {
      return {
        component,
        root,
        state: "partial",
        startedAt: marker.startedAt,
        ...marker.failureCode === undefined ? {} : { failureCode: marker.failureCode },
      };
    }
    return { component, root, state: "ready" };
  }

  private async readMarker(component: string, root: string): Promise<PartialMarker | undefined> {
    const markerPath = path.join(root, PARTIAL_MARKER);
    let metadata;
    try {
      metadata = await lstat(markerPath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    // Never follow a marker symlink or special file. Its mere presence is still
    // conservative proof that a download did not finish.
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { component, startedAt: "unknown", pid: 0 };
    }
    try {
      const raw = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") {
        return { component, startedAt: "unknown", pid: 0 };
      }
      const value = raw as Partial<PartialMarker>;
      if (
        value.component !== component
        || typeof value.startedAt !== "string"
        || typeof value.pid !== "number"
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 0
      ) {
        return { component, startedAt: "unknown", pid: 0 };
      }
      const mappedFailureCode = markerFailureCode(value.failureCode);
      return {
        component,
        startedAt: value.startedAt,
        pid: value.pid,
        ...mappedFailureCode === undefined ? {} : { failureCode: mappedFailureCode },
      };
    } catch {
      // An unreadable or malformed marker still means a download was started
      // and never finished, which is the conservative reading.
      return { component, startedAt: "unknown", pid: 0 };
    }
  }

  /**
   * Runs one abort-aware download under its component lock and timeout.
   *
   * A failure leaves the marker in place on purpose: the directory holds
   * whatever partial bytes arrived, and the next run must see that rather than
   * mistake it for a finished download. On timeout the signal is aborted, but
   * the lock remains held until the operation settles so no later attempt can
   * overlap its cleanup or final writes. Cooperative operations should honor
   * the signal promptly; a non-cooperative operation keeps the lease until it
   * eventually settles, while the timed-out caller still returns immediately.
   */
  async download<T>(
    component: string,
    operation: (root: string, signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("download timeout must be a positive safe integer");
    }
    const root = await this.ensureComponentRoot(component);

    const lease = await this.componentLock(root).acquire();
    let leaseTransferred = false;
    try {
      // Revalidate after waiting: a path substituted during lock contention
      // must not gain authority to receive marker or download writes.
      await this.ensureComponentRoot(component);
      const marker: PartialMarker = {
        component,
        startedAt: this.clock().toISOString(),
        pid: process.pid,
      };
      await this.writeMarker(root, marker);

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutError = new RuntimeAssetError(
        ErrorCode.DownloadUnavailable,
        `downloading ${component} exceeded ${timeoutMs}ms`,
        { component, timeoutMs },
      );
      const operationSettled = Promise.resolve()
        .then(() => operation(root, controller.signal))
        .then(
          (value) => ({ kind: "success" as const, value }),
          (error: unknown) => ({ kind: "failure" as const, error }),
        );
      const expiry = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: "timeout" });
          controller.abort(timeoutError);
        }, timeoutMs);
      });
      try {
        const outcome = await Promise.race([operationSettled, expiry]);
        if (outcome.kind === "timeout") {
          const markerRecorded = this.writeMarker(root, {
            ...marker,
            failureCode: ErrorCode.DownloadUnavailable,
          }).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          // Return the coded timeout promptly, but transfer the lease to a
          // background finalizer. It cannot release until both the marker write
          // and the downloader's post-abort cleanup have settled.
          this.retainLeaseUntil(Promise.all([operationSettled, markerRecorded]), lease);
          leaseTransferred = true;
          const recorded = await markerRecorded;
          if (!recorded.ok) throw recorded.error;
          throw timeoutError;
        }
        if (outcome.kind === "failure") throw outcome.error;
        // Only a reported success clears the marker.
        await rm(path.join(root, PARTIAL_MARKER), { force: true });
        return outcome.value;
      } catch (error) {
        const mappedFailureCode = failureCode(error);
        if (mappedFailureCode !== undefined && !leaseTransferred) {
          await this.writeMarker(root, { ...marker, failureCode: mappedFailureCode });
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      if (!leaseTransferred) await lease.release();
    }
  }

  /** Discards a partial component so the next attempt starts from nothing. */
  async discardPartial(component: string): Promise<void> {
    await this.inspectCacheRoot(true);
    const root = this.componentRoot(component);
    await this.componentLock(root).runExclusive(async () => {
      const status = await this.status(component);
      if (status.state !== "partial") return;
      await this.inspectComponentRoot(component, false);
      await rm(status.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    });
  }

  /** Records a component as complete without downloading, for tests and repair. */
  async markReady(component: string): Promise<void> {
    const root = await this.ensureComponentRoot(component);
    await this.componentLock(root).runExclusive(async () => {
      await this.ensureComponentRoot(component);
      await rm(path.join(root, PARTIAL_MARKER), { force: true });
    });
  }

  /** Writes a marker without downloading, so an interrupted run can be simulated. */
  async markPartial(component: string, mappedFailureCode?: DownloadFailureCode): Promise<void> {
    const root = await this.ensureComponentRoot(component);
    await this.componentLock(root).runExclusive(async () => {
      await this.ensureComponentRoot(component);
      await this.writeMarker(root, {
        component,
        startedAt: this.clock().toISOString(),
        pid: process.pid,
        ...mappedFailureCode === undefined ? {} : { failureCode: mappedFailureCode },
      });
    });
  }
}
