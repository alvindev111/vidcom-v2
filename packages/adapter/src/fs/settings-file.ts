import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  DEFAULT_VIDCOM_SETTINGS,
  resolveVidcomSettings,
  VidcomSettingsSchema,
  type ResolvedVidcomSettings,
  type VidcomSettingsDto,
} from "@vidcom/contracts";

import { secureAppDataDirectorySync, secureCredentialFile } from "./credential-store";

const SETTINGS_FILENAME = "setting.json";

/** Raised when the settings file exists but cannot be honoured as written. */
export class VidcomSettingsError extends Error {
  constructor(readonly pathname: string, detail: string, options?: ErrorOptions) {
    super(`${pathname} could not be read as VidCom settings: ${detail}`, options);
    this.name = "VidcomSettingsError";
  }
}

/**
 * The directory holding user-level VidCom configuration, `~/.vidcom` by default.
 *
 * A fixed home-relative path rather than the platform application-data
 * directory: this file has to be found *before* anything is configured, since it
 * is what may declare where application data itself lives. `VIDCOM_HOME`
 * relocates it for tests and for a portable install.
 */
export function vidcomHome(): string {
  return process.env.VIDCOM_HOME ? path.resolve(process.env.VIDCOM_HOME) : path.join(homedir(), ".vidcom");
}

/** Absolute path of the settings file; `VIDCOM_SETTINGS` names it directly. */
export function defaultSettingsPath(): string {
  return process.env.VIDCOM_SETTINGS
    ? path.resolve(process.env.VIDCOM_SETTINGS)
    : path.join(vidcomHome(), SETTINGS_FILENAME);
}

/**
 * Settings read from disk with every gap defaulted, or the defaults when no file
 * exists yet.
 *
 * Throws `VidcomSettingsError` when the file exists but is malformed or declares
 * an unknown key. Ignoring a broken settings file would mean a user's API key or
 * workspace silently does nothing while the daemon reports itself healthy — the
 * hardest kind of misconfiguration to find. A missing file is not an error.
 *
 * Never logs or returns the file's contents in the error message; a parse error
 * quotes the reason, not the line.
 */
export async function readVidcomSettings(
  pathname: string = defaultSettingsPath(),
): Promise<ResolvedVidcomSettings> {
  let raw: string;
  try {
    raw = await readFile(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_VIDCOM_SETTINGS;
    throw new VidcomSettingsError(pathname, "the file could not be opened", { cause: error });
  }
  if (!raw.trim()) return DEFAULT_VIDCOM_SETTINGS;

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new VidcomSettingsError(pathname, "the file is not valid JSON", { cause: error });
  }
  const parsed = VidcomSettingsSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "the document root";
    // The issue message names the field and the rule, never the value — an
    // invalid apiKey must not end up in a log line.
    throw new VidcomSettingsError(pathname, `${where} is invalid (${issue?.message ?? "unknown reason"})`);
  }
  return resolveVidcomSettings(parsed.data);
}

/**
 * Writes settings atomically with owner-only permissions and returns the path.
 *
 * The file holds a paid-service API key, so it gets the same treatment as the
 * MCP bridge credential: `0600` on POSIX, an ACL naming only the current user on
 * Windows, and a directory nobody else can traverse.
 */
export async function writeVidcomSettings(
  document: VidcomSettingsDto,
  pathname: string = defaultSettingsPath(),
): Promise<string> {
  const directory = path.dirname(pathname);
  await mkdir(directory, { recursive: true });
  secureAppDataDirectorySync(directory);
  await writeFile(pathname, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await secureCredentialFile(pathname);
  return pathname;
}

/**
 * Creates a commented-by-example settings file when none exists, and returns its path.
 *
 * Discoverability: a user told to "put your key in the settings file" should find
 * that file already there with the right shape, rather than have to guess the
 * schema. Writes nothing when the file exists — including when it is malformed,
 * because overwriting someone's broken edit destroys the thing they were editing.
 */
export async function ensureVidcomSettingsFile(
  pathname: string = defaultSettingsPath(),
): Promise<string> {
  try {
    await readFile(pathname, "utf8");
    return pathname;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return pathname;
  }
  return writeVidcomSettings({
    tts: {
      defaultProviderId: null,
      defaultVoiceId: null,
      defaultRatePercent: 0,
      defaultComputeDevice: "cpu",
      elevenlabs: { apiKey: null },
      vieneu: { command: null, modelRevision: null },
    },
  }, pathname);
}
