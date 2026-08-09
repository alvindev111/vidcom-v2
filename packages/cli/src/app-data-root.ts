import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ResolvedVidcomSettings } from "@vidcom/contracts";

/** Inputs used while locating app-data before the rest of the CLI is imported. */
export interface EarlyAppDataOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return undefined;
  return error.code;
}

/**
 * Returns the operating-system app-data directory, after explicit environment
 * and validated settings values have had their chance to override it.
 */
export function defaultAppDataRoot(
  settings?: Pick<ResolvedVidcomSettings, "appDataRoot">,
  options: EarlyAppDataOptions = {},
): string {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  if (environment.VIDCOM_APP_DATA) return path.resolve(environment.VIDCOM_APP_DATA);
  if (settings?.appDataRoot) return path.resolve(settings.appDataRoot);
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "VidCom");
  if (platform === "win32") return path.join(environment.APPDATA ?? homeDirectory, "VidCom");
  return path.join(environment.XDG_DATA_HOME ?? path.join(homeDirectory, ".local", "share"), "vidcom");
}

/**
 * Reads only the app-data setting needed before production modules are loaded.
 *
 * Full strict settings validation still runs in the normal CLI boot. This
 * early reader deliberately rejects malformed JSON and a non-string
 * `appDataRoot`; silently falling back would configure esbuild for a different
 * installation than the daemon subsequently opens.
 */
export async function earlyAppDataRoot(options: EarlyAppDataOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  if (environment.VIDCOM_APP_DATA) return defaultAppDataRoot(undefined, options);
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const settingsPath = environment.VIDCOM_SETTINGS
    ? path.resolve(environment.VIDCOM_SETTINGS)
    : path.join(
        environment.VIDCOM_HOME ? path.resolve(environment.VIDCOM_HOME) : path.join(homeDirectory, ".vidcom"),
        "setting.json",
      );
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return defaultAppDataRoot(undefined, options);
    throw new Error(`the settings file could not be opened before compiler initialization`, { cause: error });
  }
  if (!raw.trim()) return defaultAppDataRoot(undefined, options);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("the settings file is not valid JSON", { cause: error });
  }
  if (!isRecord(value)) {
    throw new Error("the settings document must be an object");
  }
  const appDataRoot = value.appDataRoot;
  if (appDataRoot !== undefined && appDataRoot !== null && typeof appDataRoot !== "string") {
    throw new Error("appDataRoot in the settings file must be a string or null");
  }
  const settings: Pick<ResolvedVidcomSettings, "appDataRoot"> = {
    appDataRoot: typeof appDataRoot === "string" ? appDataRoot : null,
  };
  return defaultAppDataRoot(settings, options);
}
