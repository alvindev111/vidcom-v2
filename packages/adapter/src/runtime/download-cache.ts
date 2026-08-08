import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ErrorCode } from "@vidcom/contracts";

import { writeAtomic } from "../fs/atomic-write";
import { AtomicDirectoryLock } from "./atomic-directory-lock";
import { RuntimeAssetError } from "./runtime-asset-source";

const PARTIAL_MARKER = ".downloading.json";
const COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export type DownloadCacheState = "missing" | "partial" | "ready";

export interface DownloadCacheStatus {
  component: string;
  root: string;
  state: DownloadCacheState;
  /** Present only while a download is recorded as in flight. */
  startedAt?: string;
}

export interface PartialMarker {
  component: string;
  startedAt: string;
  pid: number;
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

  constructor(options: DownloadCacheOptions) {
    if (!path.isAbsolute(options.cacheRoot)) {
      throw new TypeError("download cache root must be absolute");
    }
    this.cacheRoot = options.cacheRoot;
    this.clock = options.clock ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  componentRoot(component: string): string {
    assertComponent(component);
    return path.join(this.cacheRoot, component);
  }

  private markerPath(component: string): string {
    return path.join(this.componentRoot(component), PARTIAL_MARKER);
  }

  /** Classifies a component without trusting anything the downloaded tool says. */
  async status(component: string): Promise<DownloadCacheStatus> {
    const root = this.componentRoot(component);
    const marker = await this.readMarker(component);
    if (marker) {
      return { component, root, state: "partial", startedAt: marker.startedAt };
    }
    const present = await lstat(root).then((value) => value.isDirectory(), () => false);
    return { component, root, state: present ? "ready" : "missing" };
  }

  private async readMarker(component: string): Promise<PartialMarker | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.markerPath(component), "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return undefined;
      const value = raw as Partial<PartialMarker>;
      if (typeof value.startedAt !== "string" || typeof value.pid !== "number") return undefined;
      return { component, startedAt: value.startedAt, pid: value.pid };
    } catch {
      // An unreadable or malformed marker still means a download was started
      // and never finished, which is the conservative reading.
      return await lstat(this.markerPath(component)).then(
        () => ({ component, startedAt: "unknown", pid: 0 }),
        () => undefined,
      );
    }
  }

  /**
   * Runs one download under its component lock, bounded by a timeout.
   *
   * A failure leaves the marker in place on purpose: the directory holds
   * whatever partial bytes arrived, and the next run must see that rather than
   * mistake it for a finished download.
   */
  async download<T>(
    component: string,
    operation: (root: string) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("download timeout must be a positive safe integer");
    }
    const root = this.componentRoot(component);
    await mkdir(root, { recursive: true, mode: 0o700 });

    const lock = new AtomicDirectoryLock(`${root}.lock`, {
      ...this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs },
      timeoutCode: ErrorCode.DownloadUnavailable,
    });
    return lock.runExclusive(async () => {
      await writeAtomic(this.markerPath(component) as never, `${JSON.stringify({
        component,
        startedAt: this.clock().toISOString(),
        pid: process.pid,
      })}\n`);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => { resolve("timeout"); }, timeoutMs);
      });
      try {
        const outcome = await Promise.race([
          Promise.resolve().then(() => operation(root)).then((value) => ({ value })),
          expiry,
        ]);
        if (outcome === "timeout") {
          throw new RuntimeAssetError(
            ErrorCode.DownloadUnavailable,
            `downloading ${component} exceeded ${timeoutMs}ms`,
            { component, timeoutMs },
          );
        }
        // Only a reported success clears the marker.
        await rm(this.markerPath(component), { force: true });
        return outcome.value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  }

  /** Discards a partial component so the next attempt starts from nothing. */
  async discardPartial(component: string): Promise<void> {
    const status = await this.status(component);
    if (status.state !== "partial") return;
    await rm(status.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  /** Records a component as complete without downloading, for tests and repair. */
  async markReady(component: string): Promise<void> {
    await mkdir(this.componentRoot(component), { recursive: true, mode: 0o700 });
    await rm(this.markerPath(component), { force: true });
  }

  /** Writes a marker without downloading, so an interrupted run can be simulated. */
  async markPartial(component: string): Promise<void> {
    await mkdir(this.componentRoot(component), { recursive: true, mode: 0o700 });
    await writeFile(this.markerPath(component), `${JSON.stringify({
      component,
      startedAt: this.clock().toISOString(),
      pid: process.pid,
    })}\n`, "utf8");
  }
}
