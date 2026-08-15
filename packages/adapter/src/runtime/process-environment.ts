/** Parent variables a supervised child may inherit unless the caller names more. */
const INHERITED_ENVIRONMENT = [
  "PATH", "Path", "PATHEXT", "NODE_ENV",
  "HOME", "USERPROFILE", "SystemRoot", "SystemDrive", "windir", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  "PYTHONIOENCODING", "PYTHONUTF8", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
] as const;

export interface ChildEnvironmentOptions {
  /**
   * A CA bundle every Node child should trust.
   *
   * Passed rather than discovered: a frozen runtime carries no trust store of
   * its own, and picking certificates out of the OS store would turn a download
   * failure into a silent one. Disabling verification is not an option here for
   * the same reason.
   */
  caBundlePath?: string;
}

/** Reduces the daemon environment to the child-process allowlist. */
export function allowlistedEnvironment(
  parent: NodeJS.ProcessEnv,
  supplied: Record<string, string> = {},
  options: ChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_ENVIRONMENT) {
    const value = parent[name];
    if (value !== undefined) environment[name] = value;
  }
  // Forced, not defaulted. A frozen interpreter takes its encoding from the ANSI
  // codepage when these are absent, and inheriting the parent's value carries
  // that codepage straight through — measured as cp932 on a Windows host, where
  // printing Vietnamese raises UnicodeEncodeError. The parent never wins here;
  // an explicit caller still can, which is how the failure mode stays testable.
  environment.PYTHONIOENCODING = "utf-8";
  environment.PYTHONUTF8 = "1";
  // The extracted runtime is integrity-checked content, not a Python cache.
  // Importing the bundled sidecar must not create __pycache__ beside its files.
  environment.PYTHONDONTWRITEBYTECODE = "1";
  // Both names, read out of the pinned HyperFrames CLI rather than guessed.
  // Measured at S9: with a clean HOME the very first run prints a telemetry
  // invitation, and a packaged app must not ask a question on behalf of a tool
  // the user never chose to install.
  environment.HYPERFRAMES_NO_TELEMETRY = "1";
  environment.DO_NOT_TRACK = "1";
  // Set only when configured. An empty value is not "no bundle" to Node — it is
  // a bundle at path "", which fails every TLS handshake the child attempts.
  if (options.caBundlePath !== undefined && options.caBundlePath.length > 0) {
    environment.NODE_EXTRA_CA_CERTS = options.caBundlePath;
  }
  return { NODE_ENV: parent.NODE_ENV, ...environment, ...supplied };
}
