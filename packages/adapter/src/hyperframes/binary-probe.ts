import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { ErrorCode, WarningCode } from "@vidcom/contracts";
import { err, ok, type AbsolutePath, type BinaryProbePort, type ProcessPort } from "@vidcom/core";

import { DOWNLOAD_CACHE_COMPONENTS, type DownloadCacheCoordinator } from "../runtime/download-cache";
import { allowlistedEnvironment } from "../runtime/process-environment";
import { RuntimeAssetError } from "../runtime/runtime-asset-source";
import { verifyBrowserExecutable, verifyManagedBrowserExecutable } from "./browser-verification";
import { resolveChrome } from "./chrome-resolver";
import { detectHyperframesVersionSkew } from "./version-skew";

export const HYPERFRAMES_EXPECTED_VERSION = "0.7.86";
const BROWSER_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const TLS_DOWNLOAD_FAILURE = /CERTIFICATE_VERIFY_FAILED|unable to get local issuer certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN/iu;
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

/**
 * Argv that runs `script` under this executable, whatever this executable is.
 *
 * In an artifact `process.execPath` is the vidcom binary, not node. Passing a
 * script path straight to it re-enters vidcom's own command parser, which reads
 * anything beginning with `--` as `vidcom app` and starts the app instead —
 * with no error to notice. The sentinel is what makes the artifact behave like
 * node here. Outside an artifact execPath really is node and the sentinel is
 * not needed, so it is only added when this process is a packaged binary.
 */
function nodeArgv(script: string, isSea: boolean): string[] {
  return isSea ? [VIDCOM_NODE_SENTINEL, script] : [script];
}

function runningAsSea(): boolean {
  return (process.getBuiltinModule("node:sea") as { isSea(): boolean }).isSea();
}

/** The internal sentinel that makes the packaged binary act as a node runner. */
export const VIDCOM_NODE_SENTINEL = "--vidcom-node";

export interface NodeRenderBinaryProbeOptions {
  /** App-data authority the SEA child uses to verify the extracted runtime. */
  appDataRoot: string;
  /** Optional CA bundle inherited by the Node-based HyperFrames reporter. */
  caBundlePath?: string;
  /** Process-tree-aware runner used by the managed browser downloader. */
  processes?: ProcessPort;
  /** Marker/lock authority for the app-data browser cache. */
  downloadCache?: DownloadCacheCoordinator;
  /** Test seam; production uses the bounded ten-minute first-run budget. */
  browserDownloadTimeoutMs?: number;
  /**
   * Whether a missing browser may trigger the managed first-run download.
   *
   * Render and snapshot jobs are long-running and explicitly requested, so they
   * keep the default. Interactive derived caches such as timeline thumbnails
   * must stay bounded: they report the browser as missing and render a
   * placeholder rather than starting a multi-minute download from a scroll.
   */
  allowBrowserDownload?: boolean;
  /** Test seam for Node's process-wide SEA state. */
  isSea?: () => boolean;
}

/** Resolves the exact render toolchain before Chromium can be launched. */
export class NodeRenderBinaryProbe implements BinaryProbePort {
  constructor(
    private readonly paths: {
      ffmpegPath: AbsolutePath;
      ffprobePath: AbsolutePath;
      hyperframesCliPath?: AbsolutePath;
      hyperframesPackagePath?: AbsolutePath;
      /** Synthetic HOME root holding HyperFrames' nested managed cache. */
      browserCacheRoot?: AbsolutePath;
      browserPath?: AbsolutePath;
    },
    private readonly options: NodeRenderBinaryProbeOptions,
  ) {}

  private browserEnvironment(): Record<string, string> {
    const root = this.paths.browserCacheRoot;
    return {
      VIDCOM_APP_DATA: this.options.appDataRoot,
      HYPERFRAMES_NO_TELEMETRY: "1",
      ...(root ? { HOME: root, USERPROFILE: root } : {}),
    };
  }

  private async browserCommand(
    cliPath: string,
    isSea: boolean,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const command = [process.execPath, ...nodeArgv(cliPath, isSea), "browser", ...args];
    if (this.options.processes) {
      const output = await this.options.processes.run({
        command,
        environment: this.browserEnvironment(),
        timeoutMs: this.options.browserDownloadTimeoutMs ?? BROWSER_DOWNLOAD_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      if (output.timedOut || output.exitCode !== 0) {
        throw this.browserDownloadError(`${output.stderr}\n${output.stdout}`);
      }
      return output.stdout;
    }
    const result = await execFileAsync(command[0]!, command.slice(1), {
      encoding: "utf8",
      timeout: this.options.browserDownloadTimeoutMs ?? BROWSER_DOWNLOAD_TIMEOUT_MS,
      windowsHide: true,
      env: allowlistedEnvironment(
        process.env,
        this.browserEnvironment(),
        { caBundlePath: this.options.caBundlePath },
      ),
      ...(signal ? { signal } : {}),
    });
    return result.stdout;
  }

  private browserDownloadError(diagnostic: string): RuntimeAssetError {
    const code = TLS_DOWNLOAD_FAILURE.test(diagnostic)
      ? ErrorCode.DownloadTlsUntrusted
      : ErrorCode.DownloadUnavailable;
    return new RuntimeAssetError(
      code,
      code === ErrorCode.DownloadTlsUntrusted
        ? "Chromium download could not trust the remote TLS certificate"
        : "Chromium is unavailable from the configured download source",
      { component: DOWNLOAD_CACHE_COMPONENTS.browser },
    );
  }

  private async ensureManagedBrowser(
    cliPath: string,
    isSea: boolean,
    force: boolean,
  ): Promise<string> {
    const cache = this.options.downloadCache;
    const cacheRoot = this.paths.browserCacheRoot;
    if (!cache || !cacheRoot) {
      return (await this.browserCommand(cliPath, isSea, ["path"]))
        .trim().split(/\r?\n/u).at(-1) ?? "";
    }
    if (cache.componentRoot(DOWNLOAD_CACHE_COMPONENTS.browser) !== cacheRoot) {
      throw new TypeError("browser cache root must match the coordinated browser component");
    }
    return await cache.download(
      DOWNLOAD_CACHE_COMPONENTS.browser,
      async (root, signal) => {
        if (root !== cacheRoot) throw new TypeError("browser download cache authority changed");
        await this.browserCommand(
          cliPath,
          isSea,
          force ? ["ensure", "--force"] : ["ensure"],
          signal,
        );
        const candidate = (await this.browserCommand(cliPath, isSea, ["path"], signal))
          .trim().split(/\r?\n/u).at(-1) ?? "";
        const verdict = candidate
          ? await verifyManagedBrowserExecutable(candidate, cacheRoot)
          : { usable: false as const };
        if (!verdict.usable) {
          throw this.browserDownloadError("managed browser did not pass executable verification");
        }
        return verdict.canonicalPath;
      },
      this.options.browserDownloadTimeoutMs ?? BROWSER_DOWNLOAD_TIMEOUT_MS,
    );
  }

  async probe(projectRoot: AbsolutePath) {
    const missing: string[] = [];
    const isSea = (this.options.isSea ?? runningAsSea)();
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

    const managedCacheStatus = this.options.downloadCache && this.paths.browserCacheRoot
      ? await this.options.downloadCache.status(DOWNLOAD_CACHE_COMPONENTS.browser)
      : null;
    const resolvedBrowser = await resolveChrome({
      ...this.paths.browserCacheRoot && managedCacheStatus?.state !== "partial"
        ? { browserCacheRoot: this.paths.browserCacheRoot }
        : {},
      ...this.paths.browserPath ? { chromePathOverride: this.paths.browserPath } : {},
    });
    let browserPath: string | null = resolvedBrowser?.path ?? null;
    let browserDownloadFailure: RuntimeAssetError | null = null;
    if (!browserPath && cliPath && this.options.allowBrowserDownload !== false) {
      try {
        const candidate = await this.ensureManagedBrowser(
          cliPath,
          isSea,
          managedCacheStatus?.state === "ready" || managedCacheStatus?.state === "partial",
        );
        if (candidate && (await verifyBrowserExecutable(candidate)).usable) browserPath = candidate;
      } catch (error) {
        if (error instanceof RuntimeAssetError) browserDownloadFailure = error;
        // Collected with the other missing binaries below.
      }
    }
    if (!browserPath && browserDownloadFailure) {
      return err({
        code: browserDownloadFailure.code,
        message: browserDownloadFailure.message,
        details: browserDownloadFailure.details,
      });
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
    const projectVersionWarning = await detectHyperframesVersionSkew({ projectRoot, installedVersion });
    if (projectVersionWarning && !warnings.some((warning) =>
      warning.code === projectVersionWarning.code && warning.message === projectVersionWarning.message)) {
      warnings.push(projectVersionWarning);
    }
    return ok({
      // Second spawn site, same trap: the render supervisor runs this command
      // array directly, so it needs the sentinel for exactly the same reason.
      hyperframesCommand: [process.execPath, ...nodeArgv(cliPath, isSea)] as const,
      browserPath: browserPath as AbsolutePath,
      ffmpegPath: this.paths.ffmpegPath,
      ffprobePath: this.paths.ffprobePath,
      warnings,
    });
  }
}
