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

async function activeWorkspace(appDataRoot: string): Promise<string | null> {
  const database = openVidcomDatabase(appDataRoot);
  try {
    await migrateDatabase(database);
    return new AppSettingsStore(database).get("active_workspace");
  } finally {
    await database.destroy();
  }
}

/** Applies explicit -> saved active -> marker-backed cwd without guessing a projects directory. */
export async function selectWorkspace(options: {
  explicit?: string | null;
  appDataRoot: string;
  cwd?: string;
}): Promise<AbsolutePath> {
  const explicit = await candidate(options.explicit);
  if (explicit && !explicit.readable) {
    throw new CliInputError(`explicit workspace is not readable: ${explicit.root}`);
  }
  const active = explicit ? null : await activeWorkspace(options.appDataRoot);
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
  const database = openVidcomDatabase(options.appDataRoot);
  try {
    await migrateDatabase(database);
    new AppSettingsStore(database).set("active_workspace", resolution.root);
  } finally {
    await database.destroy();
  }
  return resolution.root;
}
