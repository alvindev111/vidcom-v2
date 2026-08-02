import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

import type { ContentHash } from "@vidcom/contracts";
import type {
  JournalId,
  MutationCapture,
  MutationCaptureConflict,
  ResolvedPath,
  Result,
} from "@vidcom/core";

function sha256(content: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;
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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishWithoutReplace(
  target: string,
  content: string | Uint8Array,
): Promise<boolean> {
  const directory = path.dirname(target);
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
  return true;
}

/** Captures the live target into a deterministic same-filesystem rollback slot and verifies its expected hash. */
export async function captureForMutation(
  target: ResolvedPath,
  expectedHash: ContentHash | null,
  journalId: JournalId,
  ordinal: number,
): Promise<Result<MutationCapture, MutationCaptureConflict>> {
  const directory = path.dirname(target);
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
  await syncDirectory(directory);

  const capturedHash = sha256(await readFile(rollbackPath));
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
  content: string | Uint8Array | null,
): Promise<boolean> {
  if (content === null) return !(await exists(capture.target));
  return publishWithoutReplace(capture.target, content);
}

/** Restores a captured target only if the current target still matches the mutation's landed hash. */
export async function restoreCaptured(
  capture: MutationCapture,
  landedHash: ContentHash | null,
): Promise<boolean> {
  const currentExists = await exists(capture.target);
  if (currentExists) {
    const currentHash = sha256(await readFile(capture.target));
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
  if (capture.rollbackPath !== null) await rm(capture.rollbackPath, { force: true });
  await syncDirectory(path.dirname(capture.target));
}
