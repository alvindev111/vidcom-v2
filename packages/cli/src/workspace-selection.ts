import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  AppSettingsStore,
  type VidcomDatabase,
} from "@vidcom/adapter";
import { resolveWorkspace, type AbsolutePath, type WorkspaceCandidate } from "@vidcom/core";

import { CliInputError } from "./cli-error";

/** Resolves aliases before a workspace path is used as lease or discovery identity. */
export async function canonicalWorkspaceRoot(raw: string): Promise<AbsolutePath> {
  return path.normalize(await realpath(path.resolve(raw))) as AbsolutePath;
}

async function candidate(raw: string | null | undefined): Promise<WorkspaceCandidate | null> {
  if (!raw) return null;
  const resolved = path.resolve(raw) as AbsolutePath;
  try {
    const root = await canonicalWorkspaceRoot(resolved);
    await readdir(root);
    const identity = await stat(path.join(root, "vidcom.json")).catch(() => null);
    const parent = path.dirname(root);
    const parentReadable = parent !== root
      && await readdir(parent).then(() => true).catch(() => false);
    return { root, readable: true, hasIdentityFile: identity?.isFile() === true, parentReadable };
  } catch { /* invalid candidates are handled by the resolver */ }
  return { root: resolved, readable: false, hasIdentityFile: false, parentReadable: false };
}

/**
 * Opens the settings database once for the whole selection.
 *
 * Reading the saved workspace and recording the resolved one used to open and
 * migrate the database separately, so one selection paid two migrations before
 * the foundation ran a third.
 */
/**
 * Applies explicit -> saved active -> marker-backed cwd without guessing a projects directory.
 *
 * Resolving does NOT record the result. `vidcom render --workspace X` used to
 * rewrite the workspace the UI opens by default, so a one-off render silently
 * changed where the next session started. Only a successful
 * `FoundationManager.activate` may record an active workspace (E.4).
 */
export async function selectWorkspace(options: {
  explicit?: string | null;
  appDataRoot: string;
  cwd?: string;
  /** An already-migrated database owned by the current boot/foundation. */
  database: VidcomDatabase;
}): Promise<AbsolutePath> {
  const explicit = await candidate(options.explicit);
  if (explicit && !explicit.readable) {
    throw new CliInputError(`explicit workspace is not readable: ${explicit.root}`);
  }
  const settings = new AppSettingsStore(options.database);
  return (async () => {
    const active = explicit ? null : settings.get("active_workspace");
    const resolution = resolveWorkspace({
      explicit,
      active: await candidate(active),
      cwd: explicit ? null : await candidate(options.cwd ?? process.cwd()),
    });
    if (resolution.status === "error") {
      throw new CliInputError(`${resolution.reason}: ${resolution.path}`);
    }
    for (const warning of resolution.warnings) {
      process.emitWarning(`${warning.reason}: ${warning.path}`, { code: warning.code });
    }
    return resolution.root;
  })();
}
