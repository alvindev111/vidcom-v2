import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import type { ContentHash } from "@vidcom/contracts";
import type {
  JournalId,
  WorkspaceOperationId,
  MutationCapture,
  MutationCaptureExpectation,
  MutationCaptureOptions,
  MutationLandedState,
  MutationPublishContent,
  MutationCaptureConflict,
  ResolvedPath,
  Result,
} from "@vidcom/core";

import { syncDirectory } from "./durability";

async function hashRegularFile(pathname: string): Promise<ContentHash> {
  const handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError("mutation target is not a regular file");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${digest.digest("hex")}` as ContentHash;
  } finally {
    await handle.close();
  }
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await lstat(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function publishWithoutReplace(
  target: string,
  content: string | Uint8Array,
): Promise<boolean> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(target)}.vidcom-${randomUUID()}.publish`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(directory);
  return true;
}

async function restoreSlotWithoutReplace(capture: MutationCapture): Promise<boolean> {
  if (capture.rollbackPath === null) return !(await exists(capture.target));
  try {
    await link(capture.rollbackPath, capture.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  await unlink(capture.rollbackPath);
  await syncDirectory(path.dirname(capture.target));
  if (path.dirname(capture.rollbackPath) !== path.dirname(capture.target)) {
    await syncDirectory(path.dirname(capture.rollbackPath));
  }
  return true;
}

/** Captures the live target into a deterministic same-filesystem rollback slot and verifies its expected hash. */
export async function captureForMutation(
  target: ResolvedPath,
  expectation: MutationCaptureExpectation,
  journalId: JournalId | WorkspaceOperationId,
  ordinal: number,
  options: MutationCaptureOptions = {},
): Promise<Result<MutationCapture, MutationCaptureConflict>> {
  if (expectation !== null && typeof expectation === "object" && expectation.kind === "directory") {
    let actualState: "absent" | "file" | "directory" | "other";
    try {
      const value = await lstat(target);
      actualState = value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      actualState = "absent";
    }
    const matches = expectation.existedBefore
      ? actualState === "directory"
      : actualState === "absent";
    if (!matches) return { ok: false, error: { actualState } };
    return {
      ok: true,
      value: {
        kind: "directory",
        journalId,
        ordinal,
        target,
        rollbackPath: null,
        capturedHash: null,
        existedBefore: expectation.existedBefore,
      },
    };
  }
  const expectedHash = expectation;
  const outermostRemovedDirectory = [...(options.rollbackOutside ?? [])]
    .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)[0];
  const directory = outermostRemovedDirectory ? path.dirname(outermostRemovedDirectory) : path.dirname(target);
  const rollbackPath = path.join(
    directory,
    `.${path.basename(target)}.vidcom-${journalId}-${ordinal}.rollback`,
  ) as ResolvedPath;
  if (await exists(rollbackPath)) {
    throw new Error("a mutation rollback slot already exists for this journal step");
  }

  try {
    await rename(target, rollbackPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (expectedHash !== null) return { ok: false, error: { actualHash: null } };
    return {
      ok: true,
      value: { journalId, ordinal, target, rollbackPath: null, capturedHash: null },
    };
  }
  await syncDirectory(path.dirname(target));
  if (directory !== path.dirname(target)) await syncDirectory(directory);

  const capturedHash = await hashRegularFile(rollbackPath);
  const capture: MutationCapture = { journalId, ordinal, target, rollbackPath, capturedHash };
  if (capturedHash === expectedHash) return { ok: true, value: capture };

  if (!(await restoreSlotWithoutReplace(capture))) {
    throw new Error("captured bytes changed and could not be restored without overwriting a newer target");
  }
  return { ok: false, error: { actualHash: capturedHash } };
}

/** Publishes one captured mutation without overwriting a target created by an external editor. */
export async function publishCaptured(
  capture: MutationCapture,
  content: MutationPublishContent,
): Promise<boolean> {
  if (capture.kind === "directory") {
    if (content === null || typeof content !== "object" || content instanceof Uint8Array
      || content.kind !== "directory") return false;
    if (content.action === "mkdir") {
      if (capture.existedBefore) {
        try { return (await lstat(capture.target)).isDirectory(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }
      try {
        await mkdir(capture.target, { recursive: false, mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      await syncDirectory(path.dirname(capture.target));
      return true;
    }
    try {
      await rmdir(capture.target);
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
    await syncDirectory(path.dirname(capture.target));
    return true;
  }
  if (content !== null && typeof content === "object" && !(content instanceof Uint8Array)) return false;
  if (content === null) return !(await exists(capture.target));
  return publishWithoutReplace(capture.target, content);
}

/** Restores a captured target only if the current target still matches the mutation's landed hash. */
export async function restoreCaptured(
  capture: MutationCapture,
  landedState: MutationLandedState,
): Promise<boolean> {
  if (capture.kind === "directory") {
    if (landedState === null || typeof landedState !== "object" || landedState.kind !== "directory") return false;
    let currentDirectory = false;
    try { currentDirectory = (await lstat(capture.target)).isDirectory(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentDirectory !== landedState.exists) return false;
    if (capture.existedBefore === currentDirectory) return true;
    if (capture.existedBefore) {
      await mkdir(capture.target, { recursive: false, mode: 0o700 });
    } else {
      try { await rmdir(capture.target); }
      catch (error) {
        if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    }
    await syncDirectory(path.dirname(capture.target));
    return true;
  }
  if (landedState !== null && typeof landedState === "object") return false;
  const landedHash = landedState;
  const currentExists = await exists(capture.target);
  if (currentExists) {
    const currentHash = await hashRegularFile(capture.target);
    if (currentHash !== landedHash) return false;
    const landedSlot = `${capture.target}.vidcom-${capture.journalId}-${capture.ordinal}.landed`;
    if (await exists(landedSlot)) return false;
    await rename(capture.target, landedSlot);
    await syncDirectory(path.dirname(capture.target));
    if (!(await restoreSlotWithoutReplace(capture))) return false;
    await rm(landedSlot, { force: true });
    return true;
  }
  if (landedHash !== null) return false;
  return restoreSlotWithoutReplace(capture);
}

/** Removes a rollback slot after a terminal database transition makes it unnecessary. */
export async function discardCapture(capture: MutationCapture): Promise<void> {
  if (capture.kind === "directory") return;
  if (capture.rollbackPath === null) return;
  await rm(capture.rollbackPath, { force: true });
  await syncDirectory(path.dirname(capture.rollbackPath));
}
