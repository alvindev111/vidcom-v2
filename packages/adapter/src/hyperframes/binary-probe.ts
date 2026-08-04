import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { ErrorCode, WarningCode } from "@vidcom/contracts";
import { err, ok, type AbsolutePath, type BinaryProbePort } from "@vidcom/core";

export const HYPERFRAMES_EXPECTED_VERSION = "0.7.86";
const execFileAsync = promisify(execFile);
const requireFromAdapter = createRequire(import.meta.url);
const resolveFromAdapter = Reflect.get(requireFromAdapter, "resolve") as (specifier: string) => string;

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function sameMajorMinor(left: string, right: string): boolean {
  return left.split(".").slice(0, 2).join(".") === right.split(".").slice(0, 2).join(".");
}

/** Resolves the exact render toolchain before Chromium can be launched. */
export class NodeRenderBinaryProbe implements BinaryProbePort {
  constructor(private readonly paths: {
    ffmpegPath: AbsolutePath;
    ffprobePath: AbsolutePath;
    hyperframesCliPath?: AbsolutePath;
    hyperframesPackagePath?: AbsolutePath;
    browserPath?: AbsolutePath;
  }) {}

  async probe() {
    const missing: string[] = [];
    let cliPath: string | null = null;
    let installedVersion: string | null = null;
    try {
      const candidate = this.paths.hyperframesCliPath
        ?? Reflect.apply(resolveFromAdapter, requireFromAdapter, ["hyperframes/bin/hyperframes.mjs"]) as AbsolutePath;
      if (!(await readable(candidate))) throw new Error("HyperFrames CLI is unavailable");
      cliPath = candidate;
      const packagePath = this.paths.hyperframesPackagePath
        ?? Reflect.apply(resolveFromAdapter, requireFromAdapter, ["hyperframes/package.json"]) as AbsolutePath;
      const version = (JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown }).version;
      installedVersion = typeof version === "string" ? version : null;
    } catch {
      missing.push("hyperframes");
    }

    let browserPath: string | null = null;
    if (this.paths.browserPath) {
      if (await executable(this.paths.browserPath)) browserPath = this.paths.browserPath;
    } else if (cliPath) {
      try {
        const result = await execFileAsync(process.execPath, [cliPath, "browser", "path"], {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        });
        const candidate = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
        if (candidate && await executable(candidate)) browserPath = candidate;
      } catch {
        // Collected with the other missing binaries below.
      }
    }
    if (!browserPath) missing.push("chromium");
    if (!(await executable(this.paths.ffmpegPath))) missing.push("ffmpeg");
    if (!(await executable(this.paths.ffprobePath))) missing.push("ffprobe");
    if (missing.length > 0 || !cliPath || !browserPath) {
      return err({
        code: ErrorCode.RenderBinaryMissing,
        message: `render binaries are missing: ${missing.join(", ")}`,
        details: { missing },
      });
    }

    const warnings = installedVersion && !sameMajorMinor(installedVersion, HYPERFRAMES_EXPECTED_VERSION)
      ? [{
          code: WarningCode.EngineVersionDrift,
          message: `HyperFrames ${installedVersion} differs from expected ${HYPERFRAMES_EXPECTED_VERSION}`,
        }]
      : [];
    return ok({
      hyperframesCommand: [process.execPath, cliPath] as const,
      browserPath: browserPath as AbsolutePath,
      ffmpegPath: this.paths.ffmpegPath,
      ffprobePath: this.paths.ffprobePath,
      warnings,
    });
  }
}
