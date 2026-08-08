import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ErrorCode } from "@vidcom/contracts";

import { syncDirectory } from "../fs/durability";
import {
  identitySchemesAgree,
  probeCurrentProcessIdentity,
  probeProcessIdentity,
  processIdentityMatches,
} from "./process-supervisor";
import { RuntimeAssetError } from "./runtime-asset-source";

const OWNER_FILENAME = "owner.json";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_OWNER_BYTES = 4 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIRECTORY_LOCK_LEASE_BRAND: unique symbol = Symbol("vidcom.directory-lock-lease");

/** Strict on-disk identity of the process that published a directory lock. */
export interface DirectoryLockOwner {
  pid: number;
  processStartIdentity: string;
  nonce: string;
  createdAt: string;
}

/**
 * Proof that one atomic directory lock is held by this exact process instance.
 *
 * `assertHeld()` checks the nominal in-memory lease, directory identity, and
 * owner nonce. `release()` is idempotent and removes only this lease's directory.
 */
export interface DirectoryLockLease {
  readonly [DIRECTORY_LOCK_LEASE_BRAND]: true;
  readonly lockPath: string;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/** Bounded acquisition policy for an atomic directory lock. */
export interface AtomicDirectoryLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  timeoutCode?: ErrorCode;
}

interface DirectoryIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
}

interface ExistingLock {
  identity: DirectoryIdentity;
  owner: DirectoryLockOwner | undefined;
}

interface OwnedExistingLock extends ExistingLock {
  owner: DirectoryLockOwner;
}

class AtomicDirectoryLockLease implements DirectoryLockLease {
  readonly [DIRECTORY_LOCK_LEASE_BRAND] = true as const;
  private released = false;

  constructor(
    readonly lockPath: string,
    private readonly lock: AtomicDirectoryLock,
    readonly identity: DirectoryIdentity,
    readonly owner: DirectoryLockOwner,
  ) {}

  /** Verifies that this nominal lease still owns the same directory and owner record. */
  async assertHeld(): Promise<void> {
    if (this.released) this.lock.ownershipError("directory lock lease has already been released");
    await this.lock.assertLeaseHeld(this.identity, this.owner);
  }

  /** Renames this lease to a private quarantine and removes that quarantine. */
  async release(): Promise<void> {
    if (this.released) return;
    await this.lock.releaseLease(this.identity, this.owner, () => {
      this.released = true;
    });
  }

  /** Returns true only for the lock instance that minted this still-active lease. */
  belongsTo(lock: AtomicDirectoryLock): boolean {
    return !this.released && this.lock === lock;
  }
}

/**
 * Serializes work by atomically publishing a fully-owned claim directory.
 *
 * A claim receives and fsyncs its strict owner before rename to `lockPath`, so a
 * process crash cannot leave a final ownerless lock. A valid final owner is
 * reclaimed only after an exhaustive targeted OS probe proves PID death or
 * reuse. Ownerless or malformed final locks are never deleted automatically.
 */
export class AtomicDirectoryLock {
  readonly lockPath: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly timeoutCode: ErrorCode;
  private readonly ownedClaims = new Set<string>();
  private readonly ownedQuarantines = new Set<string>();

  constructor(lockPath: string, options: AtomicDirectoryLockOptions = {}) {
    if (!path.isAbsolute(lockPath) || path.resolve(lockPath) !== lockPath || path.dirname(lockPath) === lockPath) {
      throw new TypeError("directory lock path must be a normalized absolute path");
    }
    this.lockPath = lockPath;
    this.timeoutMs = positiveDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.pollIntervalMs = positiveDuration(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.timeoutCode = options.timeoutCode ?? ErrorCode.BootstrapLockTimeout;
  }

  /**
   * Waits a bounded time for the lock and returns an ownership-verifying lease.
   *
   * The lock parent is created when absent. Every attempt first creates a unique
   * private claim, writes and fsyncs its owner, then renames the non-empty claim
   * to the final path. A losing attempt removes only its own claim directory.
   */
  async acquire(): Promise<DirectoryLockLease> {
    try {
      return await this.acquireWithinDeadline();
    } catch (error) {
      if (error instanceof RuntimeAssetError) throw error;
      throw this.runtimeError("directory lock acquisition failed", error);
    }
  }

  /** Returns true only for an active nominal lease minted by this lock instance. */
  ownsLease(lease: DirectoryLockLease): boolean {
    return lease instanceof AtomicDirectoryLockLease && lease.belongsTo(this);
  }

  private async acquireWithinDeadline(): Promise<DirectoryLockLease> {
    const nonce = randomBytes(32).toString("base64url");
    // Own identity is established before the clock starts: the timeout bounds
    // waiting for a contended lock, and charging a one-off OS probe against that
    // budget reported contention on a lock nobody held.
    const probe = await probeCurrentProcessIdentity();
    if (!probe.exhaustive || probe.identity === undefined) {
      this.ownershipError(
        "this process could not probe its own OS identity exhaustively; "
        + "refusing to publish a directory lock that cannot be proven stale later: "
        + (probe.reason ?? "no reason reported"),
      );
    }
    const owner = ownerRecord(probe.identity, nonce);
    const deadline = performance.now() + this.timeoutMs;

    await mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    while (performance.now() <= deadline) {
      const existing = await this.readExisting(this.lockPath);
      if (existing !== undefined) {
        const existingOwner = existing.owner;
        const stale = existingOwner !== undefined && await this.ownerIsProvenStale(existingOwner);
        if (performance.now() > deadline) break;
        if (stale && existingOwner !== undefined) {
          await this.reclaim({ identity: existing.identity, owner: existingOwner });
        }
        else await this.poll(deadline);
        continue;
      }
      if (!(await pathIsAbsent(this.lockPath))) {
        await this.poll(deadline);
        continue;
      }

      const lease = await this.tryPublishClaim(owner, deadline);
      if (lease !== undefined) return lease;
      await this.poll(deadline);
    }
    return await this.timeout();
  }

  /** Acquires one lease, runs `callback`, and releases the lease on every exit path. */
  async runExclusive<T>(callback: (lease: DirectoryLockLease) => Promise<T> | T): Promise<T> {
    const lease = await this.acquire();
    try {
      return await callback(lease);
    } finally {
      await lease.release();
    }
  }

  /** @internal Lease implementation entry point; callers use `DirectoryLockLease.assertHeld()`. */
  async assertLeaseHeld(identity: DirectoryIdentity, owner: DirectoryLockOwner): Promise<void> {
    try {
      if (!(await this.ownershipMatches(this.lockPath, identity, owner))) {
        this.ownershipError("directory lock ownership changed while the lease was held");
      }
    } catch (error) {
      if (error instanceof RuntimeAssetError) throw error;
      throw this.runtimeError("directory lock assertion failed", error);
    }
  }

  /** @internal Lease implementation entry point; callers use `DirectoryLockLease.release()`. */
  async releaseLease(
    identity: DirectoryIdentity,
    owner: DirectoryLockOwner,
    effectApplied: () => void,
  ): Promise<void> {
    try {
      await this.assertLeaseHeld(identity, owner);
      const quarantine = this.newQuarantinePath();
      await rename(this.lockPath, quarantine);
      if (!(await this.ownershipMatches(quarantine, identity, owner))) {
        await this.restoreQuarantine(quarantine);
        this.ownershipError("directory lock changed during release");
      }
      effectApplied();
      await this.removeOwnedQuarantine(quarantine);
    } catch (error) {
      if (error instanceof RuntimeAssetError) throw error;
      throw this.runtimeError("directory lock release failed", error);
    }
  }

  /** @internal Produces the configured stable error without exposing deletion primitives. */
  ownershipError(message: string): never {
    throw new RuntimeAssetError(this.timeoutCode, message, { lockPath: this.lockPath });
  }

  private async tryPublishClaim(
    owner: DirectoryLockOwner,
    deadline: number,
  ): Promise<DirectoryLockLease | undefined> {
    const claim = this.newClaimPath();
    let published = false;
    try {
      await mkdir(claim, { mode: 0o700 });
    } catch (error) {
      this.ownedClaims.delete(claim);
      if (hasCode(error, "EEXIST")) return undefined;
      throw error;
    }
    const identity = await directoryIdentity(claim);
    if (identity === undefined) this.ownershipError("new directory lock claim has no stable identity");

    try {
      if (process.platform !== "win32") await chmod(claim, 0o700);
      await writeOwner(claim, owner);
      await syncDirectory(claim);
      await syncDirectory(path.dirname(claim));
      if (!(await this.ownershipMatches(claim, identity, owner))) {
        await this.removeOwnedClaim(claim, identity, owner);
        return undefined;
      }
      if (performance.now() > deadline) {
        await this.removeOwnedClaim(claim, identity, owner);
        return undefined;
      }
      if (!(await pathIsAbsent(this.lockPath))) {
        await this.removeOwnedClaim(claim, identity, owner);
        return undefined;
      }
      try {
        await rename(claim, this.lockPath);
      } catch (error) {
        const contention = isIntrinsicRenameContention(error)
          || (hasCode(error, "EPERM") && !(await pathIsAbsent(this.lockPath)));
        if (contention) {
          await this.removeOwnedClaim(claim, identity, owner);
          return undefined;
        }
        throw error;
      }
      published = true;
      this.ownedClaims.delete(claim);
      await syncDirectory(path.dirname(this.lockPath));
      if (!(await this.ownershipMatches(this.lockPath, identity, owner))) {
        this.ownershipError("published directory lock ownership could not be verified");
      }
      return new AtomicDirectoryLockLease(this.lockPath, this, identity, owner);
    } catch (error) {
      if (this.ownedClaims.has(claim)) await this.removeOwnedClaim(claim, identity, owner, { allowMissingOwner: true });
      if (published) await this.abandonPublished(identity, owner);
      throw error;
    }
  }

  private async abandonPublished(identity: DirectoryIdentity, owner: DirectoryLockOwner): Promise<boolean> {
    if (!(await this.ownershipMatches(this.lockPath, identity, owner))) return false;
    const quarantine = this.newQuarantinePath();
    await rename(this.lockPath, quarantine);
    if (await this.ownershipMatches(quarantine, identity, owner)) {
      await this.removeOwnedQuarantine(quarantine);
      return true;
    }
    await this.restoreQuarantine(quarantine);
    return false;
  }

  private async ownerIsProvenStale(owner: DirectoryLockOwner): Promise<boolean> {
    const probe = await probeProcessIdentity(owner.pid);
    if (!probe.exhaustive) return false;
    // An absent PID proves death regardless of how identities are measured. A
    // present one only disproves it when both sides were measured the same way:
    // an owner recorded under an older scheme would otherwise read as a
    // mismatch, and a live process would have its lock taken away.
    if (
      probe.identity !== undefined
      && !identitySchemesAgree(owner.processStartIdentity, probe.identity.startedAt)
    ) return false;
    return !processIdentityMatches(
      { pid: owner.pid, startedAt: owner.processStartIdentity },
      probe.identity,
    );
  }

  private async reclaim(expected: OwnedExistingLock): Promise<boolean> {
    const current = await this.readExisting(this.lockPath);
    if (
      current?.owner === undefined
      || !sameDirectory(current.identity, expected.identity)
      || !sameOwner(current.owner, expected.owner)
    ) return false;

    const quarantine = this.newQuarantinePath();
    try {
      await rename(this.lockPath, quarantine);
    } catch (error) {
      const contention = isIntrinsicRenameContention(error)
        || (hasCode(error, "EPERM")
          && !(await pathIsAbsent(this.lockPath))
          && await pathIsAbsent(quarantine));
      if (hasCode(error, "ENOENT") || contention) {
        this.ownedQuarantines.delete(quarantine);
        return false;
      }
      throw error;
    }

    const quarantined = await this.readExisting(quarantine);
    if (
      quarantined?.owner === undefined
      || !sameDirectory(quarantined.identity, expected.identity)
      || !sameOwner(quarantined.owner, expected.owner)
    ) {
      await this.restoreQuarantine(quarantine);
      return false;
    }
    await this.removeOwnedQuarantine(quarantine);
    return true;
  }

  private async ownershipMatches(
    directory: string,
    identity: DirectoryIdentity,
    owner: DirectoryLockOwner,
  ): Promise<boolean> {
    const existing = await this.readExisting(directory);
    return existing !== undefined
      && sameDirectory(existing.identity, identity)
      && existing.owner !== undefined
      && sameOwner(existing.owner, owner);
  }

  private async readExisting(directory: string): Promise<ExistingLock | undefined> {
    const before = await directoryIdentity(directory);
    if (before === undefined) return undefined;
    const owner = await readOwner(directory);
    const after = await directoryIdentity(directory);
    if (after === undefined || !sameDirectory(before, after)) return undefined;
    return { identity: after, owner };
  }

  private newClaimPath(): string {
    const claim = path.join(
      path.dirname(this.lockPath),
      `.${path.basename(this.lockPath)}.claim-${process.pid}-${randomBytes(16).toString("hex")}`,
    );
    this.ownedClaims.add(claim);
    return claim;
  }

  private newQuarantinePath(): string {
    const quarantine = path.join(
      path.dirname(this.lockPath),
      `.${path.basename(this.lockPath)}.quarantine-${process.pid}-${randomBytes(16).toString("hex")}`,
    );
    this.ownedQuarantines.add(quarantine);
    return quarantine;
  }

  private async removeOwnedClaim(
    claim: string,
    identity: DirectoryIdentity,
    owner: DirectoryLockOwner,
    options: { allowMissingOwner?: boolean } = {},
  ): Promise<void> {
    if (!this.ownedClaims.has(claim)) this.ownershipError("refusing to delete an unowned lock claim");
    const existing = await this.readExisting(claim);
    if (
      existing === undefined
      || !sameDirectory(existing.identity, identity)
      || (existing.owner === undefined
        ? options.allowMissingOwner !== true
        : !sameOwner(existing.owner, owner))
    ) this.ownershipError("refusing to delete a lock claim whose ownership changed");
    await rm(claim, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    this.ownedClaims.delete(claim);
    await syncDirectory(path.dirname(claim));
  }

  private async restoreQuarantine(quarantine: string): Promise<void> {
    if (!this.ownedQuarantines.has(quarantine)) {
      this.ownershipError("refusing to restore an unowned lock quarantine");
    }
    try {
      await rename(quarantine, this.lockPath);
      this.ownedQuarantines.delete(quarantine);
      await syncDirectory(path.dirname(this.lockPath));
    } catch (error) {
      if (!isIntrinsicRenameContention(error) && !hasCode(error, "EPERM")) throw error;
    }
  }

  private async removeOwnedQuarantine(quarantine: string): Promise<void> {
    if (!this.ownedQuarantines.has(quarantine)) {
      this.ownershipError("refusing to delete an unowned lock quarantine");
    }
    await rm(quarantine, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    this.ownedQuarantines.delete(quarantine);
    await syncDirectory(path.dirname(quarantine));
  }

  private async poll(deadline: number): Promise<void> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    await sleep(Math.min(this.pollIntervalMs, remaining));
  }

  private async timeout(): Promise<never> {
    const details: Record<string, unknown> = {
      lockPath: this.lockPath,
      timeoutMs: this.timeoutMs,
    };
    try {
      const existing = await this.readExisting(this.lockPath);
      if (existing?.owner !== undefined) {
        details.owner = {
          pid: existing.owner.pid,
          processStartIdentity: existing.owner.processStartIdentity,
          createdAt: existing.owner.createdAt,
        };
      } else if (!(await pathIsAbsent(this.lockPath))) {
        details.owner = "missing_or_invalid";
      }
    } catch {
      details.owner = "unreadable";
    }
    throw new RuntimeAssetError(
      this.timeoutCode,
      `timed out waiting ${this.timeoutMs}ms for directory lock`,
      details,
    );
  }

  private runtimeError(message: string, error: unknown): RuntimeAssetError {
    return new RuntimeAssetError(this.timeoutCode, message, {
      lockPath: this.lockPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function ownerRecord(identity: { pid: number; startedAt: string }, nonce: string): DirectoryLockOwner {
  return Object.freeze({
    pid: identity.pid,
    processStartIdentity: identity.startedAt,
    nonce,
    createdAt: new Date().toISOString(),
  });
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return duration;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity | undefined> {
  try {
    const stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory()) return undefined;
    return {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      birthtimeNs: stat.birthtimeNs.toString(),
    };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function pathIsAbsent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function writeOwner(directory: string, owner: DirectoryLockOwner): Promise<void> {
  const filename = path.join(directory, OWNER_FILENAME);
  const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(filename, 0o600);
}

async function readOwner(directory: string): Promise<DirectoryLockOwner | undefined> {
  const filename = path.join(directory, OWNER_FILENAME);
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OWNER_BYTES) return undefined;
    return parseOwner(JSON.parse(await readFile(filename, "utf8")) as unknown);
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function parseOwner(value: unknown): DirectoryLockOwner | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["createdAt", "nonce", "pid", "processStartIdentity"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined;
  if (
    typeof record.processStartIdentity !== "string"
    || record.processStartIdentity.length === 0
    || record.processStartIdentity.length > 512
  ) return undefined;
  if (typeof record.nonce !== "string" || !NONCE_PATTERN.test(record.nonce)) return undefined;
  if (
    typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
    || new Date(record.createdAt).toISOString() !== record.createdAt
  ) return undefined;
  return Object.freeze({
    pid: record.pid as number,
    processStartIdentity: record.processStartIdentity,
    nonce: record.nonce,
    createdAt: record.createdAt,
  });
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs;
}

function sameOwner(left: DirectoryLockOwner, right: DirectoryLockOwner): boolean {
  return left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.nonce === right.nonce
    && left.createdAt === right.createdAt;
}

function isIntrinsicRenameContention(error: unknown): boolean {
  return hasCode(error, "EEXIST")
    || hasCode(error, "ENOTEMPTY");
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
