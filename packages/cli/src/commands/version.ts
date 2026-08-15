import { CliInputError } from "../cli-error";

/**
 * The version this build reports.
 *
 * Kept here rather than beside the command parser: the host also needs it, for
 * the handshake, and importing the parser from the host closes a cycle that
 * only shows up at runtime as a half-initialised module.
 */
export const VIDCOM_VERSION = "0.1.0";

export interface VersionReport {
  vidcom: string;
  hyperframes: string | null;
  buildCommit: string | null;
  platform: string;
  runtimeManifest: string | null;
}

export interface VersionSources {
  vidcom: string;
  /** Read from the embedded runtime manifest, which only a packaged build has. */
  runtime?: { manifestVersion: string; hyperframes: string } | null;
  buildCommit?: string | null;
  platform?: string;
}

/**
 * Reports what this executable actually is.
 *
 * Every field that a source checkout cannot know is `null` rather than a
 * plausible-looking default. This output exists to answer "which build is
 * this?" in a bug report, and a guessed version is worse than an admitted
 * blank: it sends the reader looking at the wrong release.
 */
export function versionReport(sources: VersionSources): VersionReport {
  return {
    vidcom: sources.vidcom,
    hyperframes: sources.runtime?.hyperframes ?? null,
    buildCommit: sources.buildCommit ?? null,
    platform: sources.platform ?? `${process.platform}-${process.arch}`,
    runtimeManifest: sources.runtime?.manifestVersion ?? null,
  };
}

export function formatVersionReport(report: VersionReport): string {
  const rows: Array<[string, string | null]> = [
    ["vidcom", report.vidcom],
    ["hyperframes", report.hyperframes],
    ["build commit", report.buildCommit],
    ["platform", report.platform],
    ["runtime manifest", report.runtimeManifest],
  ];
  // "not packaged" rather than an empty column: a blank reads as a bug in this
  // command, while the real answer is that a source checkout has no runtime.
  return rows.map(([label, value]) => `${label}: ${value ?? "not packaged"}`).join("\n");
}

export interface VersionCommandIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
}

export async function runVersionCommand(
  argv: readonly string[],
  sources: VersionSources,
  io: VersionCommandIo = { stdout: process.stdout },
): Promise<void> {
  let json = false;
  for (const flag of argv) {
    if (flag !== "--json") throw new CliInputError(`unknown version argument: ${flag}`);
    if (json) throw new CliInputError("--json may be provided only once");
    json = true;
  }
  const report = versionReport(sources);
  io.stdout.write(json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatVersionReport(report)}\n`);
  return Promise.resolve();
}
