import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  link,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

export class DirectoryPublishInterruption extends Error {}

const PROCESS_STARTED_AT = processStartIdentity(process.pid);
if (PROCESS_STARTED_AT === null) {
  throw new Error("the current publisher process start identity is unavailable");
}
const activePublications = new Set();
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function realDirectory(directory, label) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

async function regularFileProjection(filename, label) {
  const handle = await open(filename, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error(`${label} must be one regular file`);
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after)) throw new Error(`${label} changed while it was hashed`);
    return {
      bytes: before.size.toString(),
      mode: Number(before.mode & 0o777n),
      sha256: digest.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

/** Binds every path, mode, size and file byte in one published directory. */
export async function directoryPayloadDigest(directory, authorityFile) {
  const root = path.resolve(directory);
  await realDirectory(root, "generation");
  const authority = path.join(root, authorityFile);
  const authorityMetadata = await lstat(authority);
  if (!authorityMetadata.isFile() || authorityMetadata.isSymbolicLink() || authorityMetadata.nlink !== 1) {
    throw new Error(`generation authority ${authorityFile} must be one regular file`);
  }

  const digest = createHash("sha256");
  const visit = async (current, relative) => {
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink()) throw new Error(`generation payload contains a symbolic link: ${relative}`);
    if (metadata.isDirectory()) {
      digest.update(`${JSON.stringify(["directory", relative, Number(metadata.mode & 0o777n)])}\n`);
      const names = (await readdir(current)).sort(compareUtf8);
      for (const name of names) {
        const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
        await visit(path.join(current, name), childRelative);
      }
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1n) {
      throw new Error(`generation payload contains a special or hard-linked file: ${relative}`);
    }
    const projection = await regularFileProjection(current, `generation payload ${relative}`);
    digest.update(`${JSON.stringify(["file", relative, projection.mode, projection.bytes, projection.sha256])}\n`);
  };
  await visit(root, "");
  return digest.digest("hex");
}

function transactionPath(published) {
  return `${published}.transaction.json`;
}

function lockPath(published) {
  return `${published}.publish.lock`;
}

function pendingPath(filename, token) {
  return `${filename}.pending-${token}`;
}

async function publishJsonExclusive(filename, value, token) {
  const pending = pendingPath(filename, token);
  const handle = await open(pending, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(pending, filename);
  } finally {
    await rm(pending, { force: true });
  }
}

async function readJsonAuthority(filename, tokenKey, label) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink < 1 || metadata.nlink > 2) {
    throw new Error(`${label} must be one regular file`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const token = value?.[tokenKey];
  if (metadata.nlink === 2) {
    if (typeof token !== "string") throw new Error(`${label} is invalid`);
    const pending = pendingPath(filename, token);
    const pendingMetadata = await lstat(pending);
    if (pendingMetadata.dev !== metadata.dev || pendingMetadata.ino !== metadata.ino) {
      throw new Error(`${label} has an unowned hard link`);
    }
    await rm(pending);
    const healed = await lstat(filename);
    if (healed.nlink !== 1) throw new Error(`${label} has an unowned hard link`);
  }
  return value;
}

function exactLock(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("publish lock is invalid");
  const keys = Object.keys(value).sort();
  const wanted = ["kind", "ownerPid", "ownerStart", "ownerToken", "published", "schemaVersion"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) throw new Error("publish lock fields are invalid");
  if (
    value.schemaVersion !== 1
    || value.kind !== expected.kind
    || value.published !== expected.published
    || !Number.isSafeInteger(value.ownerPid)
    || value.ownerPid <= 0
    || typeof value.ownerStart !== "string"
    || value.ownerStart.length === 0
    || value.ownerStart.length > 256
    || typeof value.ownerToken !== "string"
    || !UUID.test(value.ownerToken)
  ) throw new Error("publish lock does not belong to this target");
  return value;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    throw error;
  }
}

/** Uses an OS process-start identity so a reused PID cannot inherit a lock. */
function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const value = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = value.lastIndexOf(")");
      if (commandEnd < 0) return null;
      // The suffix begins at field 3; process start time is field 22.
      const started = value.slice(commandEnd + 1).trim().split(/\s+/u)[19];
      return started && /^\d+$/u.test(started) ? `linux:${started}` : null;
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    const command = [
      "$process = Get-Process -Id",
      String(pid),
      "-ErrorAction Stop; [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)",
    ].join(" ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", shell: false, windowsHide: true },
    );
    const started = result.status === 0 ? result.stdout.trim() : "";
    return /^\d+$/u.test(started) ? `win32:${started}` : null;
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    shell: false,
  });
  const started = result.status === 0 ? result.stdout.trim().replace(/\s+/gu, " ") : "";
  return started.length > 0 ? `${process.platform}:${started}` : null;
}

function processOwnsStartIdentity(pid, ownerStart) {
  if (!processExists(pid)) return false;
  const actualStart = processStartIdentity(pid);
  // A live process that cannot be inspected remains active: permission or OS
  // limitations must never authorize stealing its lock.
  return actualStart === null || actualStart === ownerStart;
}

async function readLock(options, filename = lockPath(options.published)) {
  return exactLock(await readJsonAuthority(filename, "ownerToken", "publish lock"), options);
}

async function assertOwnedLock(options, owner) {
  const current = await readLock(options);
  if (
    current.ownerPid !== owner.ownerPid
    || current.ownerStart !== owner.ownerStart
    || current.ownerToken !== owner.ownerToken
  ) throw new Error("publish lock ownership changed");
}

async function acquireLock(options) {
  const key = path.resolve(options.published);
  if (activePublications.has(key)) throw new Error("a publisher for this target is already active in this process");
  const filename = lockPath(options.published);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await options.assertAuthority?.("beforeLockMutation");
    const owner = {
      schemaVersion: 1,
      kind: options.kind,
      published: options.published,
      ownerPid: process.pid,
      ownerStart: PROCESS_STARTED_AT,
      ownerToken: randomUUID(),
    };
    try {
      await publishJsonExclusive(filename, owner, owner.ownerToken);
      activePublications.add(key);
      return owner;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    }

    const observed = await readLock(options);
    if (processOwnsStartIdentity(observed.ownerPid, observed.ownerStart)) {
      throw new Error(`a live publisher already owns this target (pid ${observed.ownerPid})`);
    }
    await options.assertAuthority?.("beforeLockRecoveryMutation");
    const stale = `${filename}.stale-${observed.ownerToken}-${randomUUID()}`;
    try {
      await rename(filename, stale);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    const moved = await readLock(options, stale);
    if (processOwnsStartIdentity(moved.ownerPid, moved.ownerStart)) {
      if (!existsSync(filename)) await rename(stale, filename);
      throw new Error(`a live publisher already owns this target (pid ${moved.ownerPid})`);
    }
    await rm(stale);
  }
  throw new Error("could not acquire the publish lock");
}

async function releaseLock(options, owner) {
  const key = path.resolve(options.published);
  try {
    await options.assertAuthority?.("beforeLockReleaseMutation");
    await assertOwnedLock(options, owner);
    await rm(lockPath(options.published));
  } finally {
    activePublications.delete(key);
  }
}

async function withLock(options, operation) {
  const owner = await acquireLock(options);
  try {
    return await operation(owner);
  } finally {
    await releaseLock(options, owner);
  }
}

function ownedGeneration(generation, published) {
  return typeof generation === "string"
    && path.isAbsolute(generation)
    && path.dirname(generation) === path.dirname(published)
    && path.basename(generation).startsWith(`${path.basename(published)}.build-`);
}

function exactTransaction(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("publish transaction is invalid");
  const keys = Object.keys(value).sort();
  const wanted = [
    "authorityFile",
    "backup",
    "generation",
    "kind",
    "nextDigest",
    "ownerPid",
    "ownerStart",
    "ownerToken",
    "previousDigest",
    "published",
    "retired",
    "schemaVersion",
    "transactionId",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) throw new Error("publish transaction fields are invalid");
  if (
    value.schemaVersion !== 2
    || value.kind !== expected.kind
    || value.published !== expected.published
    || value.backup !== expected.backup
    || value.authorityFile !== expected.authorityFile
    || typeof value.transactionId !== "string"
    || !UUID.test(value.transactionId)
    || typeof value.ownerToken !== "string"
    || !UUID.test(value.ownerToken)
    || !Number.isSafeInteger(value.ownerPid)
    || typeof value.ownerStart !== "string"
    || value.ownerStart.length === 0
    || value.ownerStart.length > 256
    || typeof value.nextDigest !== "string"
    || !SHA256.test(value.nextDigest)
    || (value.previousDigest !== null
      && (typeof value.previousDigest !== "string" || !SHA256.test(value.previousDigest)))
    || !ownedGeneration(value.generation, expected.published)
    || value.retired !== `${expected.backup}.retired-${value.transactionId}`
  ) throw new Error("publish transaction does not belong to this generation");
  if (expected.generation !== undefined && value.generation !== expected.generation) {
    throw new Error("publish transaction does not belong to this generation");
  }
  return value;
}

async function readTransaction(options) {
  const filename = transactionPath(options.published);
  if (!existsSync(filename)) return null;
  return exactTransaction(
    await readJsonAuthority(filename, "transactionId", "publish transaction"),
    options,
  );
}

async function assertDigest(directory, authorityFile, expected, label) {
  const actual = await directoryPayloadDigest(directory, authorityFile);
  if (actual !== expected) throw new Error(`${label} payload digest does not match its transaction`);
}

async function finishCommitted(options, transaction, onBoundary) {
  await assertDigest(options.published, options.authorityFile, transaction.nextDigest, "published generation");
  const hasBackup = existsSync(options.backup);
  const hasRetired = existsSync(transaction.retired);
  if (transaction.previousDigest === null) {
    if (hasBackup || hasRetired) throw new Error("unexpected previous generation in transaction");
  } else if (hasBackup) {
    if (hasRetired) throw new Error("transaction has two previous generations");
    await assertDigest(options.backup, options.authorityFile, transaction.previousDigest, "previous generation");
    await rename(options.backup, transaction.retired);
    await onBoundary?.("afterBackupRetired");
  } else if (hasRetired) {
    await assertDigest(transaction.retired, options.authorityFile, transaction.previousDigest, "retired generation");
  } else {
    throw new Error("transaction lost its previous generation");
  }
  await rm(transactionPath(options.published));
  try {
    await rm(transaction.retired, { recursive: true, force: true });
  } catch {
    // The new generation is authoritative once the journal is gone. A retired
    // directory is recoverable garbage, never a reason to corrupt publication.
  }
  return "committed";
}

async function rollbackTamperedPublished(options, transaction, previousPath) {
  await assertDigest(previousPath, options.authorityFile, transaction.previousDigest, "previous generation");
  if (existsSync(transaction.generation)) {
    throw new Error("cannot preserve a tampered generation at its owned path");
  }
  await rename(options.published, transaction.generation);
  await rename(previousPath, options.published);
  await rm(transactionPath(options.published));
  return "rolled_back";
}

async function recoverUnlocked(options, owner, onBoundary) {
  await assertOwnedLock(options, owner);
  await options.assertAuthority?.("beforeRecoveryMutation");
  const transaction = await readTransaction(options);
  if (!transaction) {
    if (existsSync(options.backup)) throw new Error("foreign publish backup exists without a matching transaction");
    return "clean";
  }
  if (
    transaction.ownerToken !== owner.ownerToken
    && processOwnsStartIdentity(transaction.ownerPid, transaction.ownerStart)
    && !(transaction.ownerPid === process.pid && transaction.ownerStart === PROCESS_STARTED_AT)
  ) throw new Error(`a live transaction still belongs to pid ${transaction.ownerPid}`);

  const hasPublished = existsSync(options.published);
  const hasBackup = existsSync(options.backup);
  const hasRetired = existsSync(transaction.retired);
  const hasGeneration = existsSync(transaction.generation);
  if (hasPublished) {
    const publishedDigest = await directoryPayloadDigest(options.published, options.authorityFile);
    if (publishedDigest === transaction.nextDigest) {
      return finishCommitted(options, transaction, onBoundary);
    }
    if (
      transaction.previousDigest !== null
      && publishedDigest === transaction.previousDigest
      && !hasBackup
      && !hasRetired
    ) {
      await rm(transactionPath(options.published));
      return "rolled_back";
    }
    if (transaction.previousDigest !== null && hasBackup) {
      return rollbackTamperedPublished(options, transaction, options.backup);
    }
    if (transaction.previousDigest !== null && hasRetired) {
      return rollbackTamperedPublished(options, transaction, transaction.retired);
    }
    throw new Error("published directory does not match either journal-bound generation");
  }

  if (hasBackup) {
    if (transaction.previousDigest === null) throw new Error("transaction backup has no previous digest");
    await assertDigest(options.backup, options.authorityFile, transaction.previousDigest, "previous generation");
    await rename(options.backup, options.published);
    await rm(transactionPath(options.published));
    return "rolled_back";
  }
  if (transaction.previousDigest === null && hasGeneration) {
    await assertDigest(transaction.generation, options.authorityFile, transaction.nextDigest, "next generation");
    await rename(transaction.generation, options.published);
    return finishCommitted(options, transaction, onBoundary);
  }
  throw new Error("publish transaction has no recoverable generation");
}

/** Recovers only a lock+journal-bound previous/next generation. */
export async function recoverDirectoryGeneration(options) {
  return withLock(options, (owner) => recoverUnlocked(options, owner));
}

export async function commitDirectoryGeneration(options) {
  return withLock(options, async (owner) => {
    await recoverUnlocked(options, owner);
    await realDirectory(options.generation, "next generation");
    if (!ownedGeneration(options.generation, options.published)) {
      throw new Error("next generation path is outside its owned namespace");
    }
    const previousDigest = existsSync(options.published)
      ? await directoryPayloadDigest(options.published, options.authorityFile)
      : null;
    const nextDigest = await directoryPayloadDigest(options.generation, options.authorityFile);
    const transactionId = randomUUID();
    const transaction = {
      schemaVersion: 2,
      kind: options.kind,
      transactionId,
      published: options.published,
      backup: options.backup,
      retired: `${options.backup}.retired-${transactionId}`,
      generation: options.generation,
      authorityFile: options.authorityFile,
      ownerPid: owner.ownerPid,
      ownerStart: owner.ownerStart,
      ownerToken: owner.ownerToken,
      previousDigest,
      nextDigest,
    };
    await assertOwnedLock(options, owner);
    await options.assertAuthority?.("beforeJournalMutation");
    await publishJsonExclusive(
      transactionPath(options.published),
      transaction,
      transaction.transactionId,
    );
    try {
      await options.onBoundary?.("afterJournal");
      await assertOwnedLock(options, owner);
      await assertDigest(options.generation, options.authorityFile, nextDigest, "next generation");
      if (previousDigest !== null) {
        await assertDigest(options.published, options.authorityFile, previousDigest, "published generation");
        await options.assertAuthority?.("beforePreviousRename");
        await rename(options.published, options.backup);
        await options.onBoundary?.("afterPreviousRename");
        await assertOwnedLock(options, owner);
        await assertDigest(options.generation, options.authorityFile, nextDigest, "next generation");
      }
      await options.assertAuthority?.("beforeGenerationRename");
      await rename(options.generation, options.published);
      await options.onBoundary?.("afterGenerationRename");
      await assertOwnedLock(options, owner);
      await assertDigest(options.published, options.authorityFile, nextDigest, "published generation");
      await recoverUnlocked(options, owner, options.onBoundary);
    } catch (error) {
      if (error instanceof DirectoryPublishInterruption) throw error;
      try {
        await recoverUnlocked(options, owner);
      } catch {
        // Preserve every generation and the transaction for the next recovery.
      }
      throw error;
    }
    return options.published;
  });
}
