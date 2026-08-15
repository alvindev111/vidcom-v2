import { readFile } from "node:fs/promises";
import path from "node:path";

import { WarningCode } from "@vidcom/contracts";

/** Same shape the binary probe already reports warnings in. */
export interface VersionSkewWarning {
  code: WarningCode;
  message: string;
}

/**
 * Compares the HyperFrames version a project declares against the one the
 * artifact actually ships.
 *
 * Rendering with a different engine than the project asked for changes output
 * without saying so, which is the worst of the three possible behaviours here.
 * Rewriting the project's `hyperframes.json` to match is the second worst: it
 * edits a file the user owns to silence a warning about their own intent. So
 * this only reports, and the caller surfaces the warning.
 *
 * Absence is not drift. A project that declares no version is accepting
 * whatever ships, and a malformed declaration is not evidence of a mismatch.
 */
export async function detectHyperframesVersionSkew(input: {
  projectRoot: string;
  installedVersion: string | null;
}): Promise<VersionSkewWarning | null> {
  if (!input.installedVersion) return null;
  const declared = await declaredVersion(input.projectRoot);
  if (!declared || declared === input.installedVersion) return null;
  return {
    code: WarningCode.EngineVersionDrift,
    message: `this project declares HyperFrames ${declared} but the runtime ships ${input.installedVersion};`
      + " rendering continues on the shipped engine and the project file is left unchanged",
  };
}

async function declaredVersion(projectRoot: string): Promise<string | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(projectRoot, "hyperframes.json"), "utf8"),
    ) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = (raw as { hyperframes?: unknown; version?: unknown });
    // Both spellings occur in the wild; neither is authoritative over the other.
    const declared = typeof value.hyperframes === "string" ? value.hyperframes : value.version;
    return typeof declared === "string" && declared.trim().length > 0 ? declared.trim() : null;
  } catch {
    return null;
  }
}
