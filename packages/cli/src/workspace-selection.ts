import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { AppSettingsStore, migrateDatabase, openVidcomDatabase } from "@vidcom/adapter";
import { resolveWorkspace, type AbsolutePath, type WorkspaceCandidate } from "@vidcom/core";

import { CliInputError } from "./cli-error";

async function candidate(raw: string | null | undefined): Promise<WorkspaceCandidate | null> {
  if (!raw) return null;
  const root = path.resolve(raw) as AbsolutePath;
  try {
    await readdir(root);
    const identity = await stat(path.join(root, "vidcom.json")).catch(() => null);
    const parent = path.dirname(root);
    const parentReadable = parent !== root
      && await readdir(parent).then(() => true).catch(() => false);
    return { root, readable: true, hasIdentityFile: identity?.isFile() === true, parentReadable };
  } catch { /* invalid candidates are handled by the resolver */ }
  return { root, readable: false, hasIdentityFile: false, parentReadable: false };
}

/**
 * Opens the settings database once for the whole selection.
 *
 * Reading the saved workspace and recording the resolved one used to open and
 * migrate the database separately, so one selection paid two migrations before
 * the foundation ran a third.
 */
async function withSettings<T>(
  appDataRoot: string,
  operation: (settings: AppSettingsStore) => Promise<T> | T,
): Promise<T> {
  const database = openVidcomDatabase(appDataRoot);
  try {
    await migrateDatabase(database);
    return await operation(new AppSettingsStore(database));
  } finally {
    await database.destroy();
  }
}

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
}): Promise<AbsolutePath> {
  const explicit = await candidate(options.explicit);
  if (explicit && !explicit.readable) {
    throw new CliInputError(`explicit workspace is not readable: ${explicit.root}`);
  }
  return withSettings(options.appDataRoot, async (settings) => {
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
  });
}
