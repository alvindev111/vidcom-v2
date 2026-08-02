import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { AppSettingsStore, migrateDatabase, openVidcomDatabase } from "@vidcom/adapter";
import { resolveWorkspace, type AbsolutePath, type WorkspaceCandidate } from "@vidcom/core";

import { CliInputError } from "./cli-error";

async function candidate(raw: string | null | undefined): Promise<WorkspaceCandidate | null> {
  if (!raw) return null;
  const root = path.resolve(raw) as AbsolutePath;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const project = path.join(root, entry.name);
      const [config, source] = await Promise.all([
        stat(path.join(project, "hyperframes.json")),
        stat(path.join(project, "index.html")),
      ]).catch(() => []);
      if (config?.isFile() && source?.isFile()) return { root, valid: true };
    }
  } catch { /* invalid candidates are handled by the resolver */ }
  return { root, valid: false };
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
  if (explicit && !explicit.valid) {
    throw new CliInputError("explicit workspace is invalid or contains no valid project");
  }
  const active = explicit ? null : await activeWorkspace(options.appDataRoot);
  const resolution = resolveWorkspace({
    explicit,
    active: await candidate(active),
    cwd: explicit ? null : await candidate(options.cwd ?? process.cwd()),
  });
  if (resolution.status === "selection_required") {
    throw new Error("workspace selection required; pass --workspace or VIDCOM_WORKSPACE");
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
