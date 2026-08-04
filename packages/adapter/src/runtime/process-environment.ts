/** Parent variables a supervised child may inherit unless the caller names more. */
const INHERITED_ENVIRONMENT = [
  "PATH", "Path", "PATHEXT", "NODE_ENV",
  "HOME", "USERPROFILE", "SystemRoot", "SystemDrive", "windir", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  "PYTHONIOENCODING", "PYTHONUTF8", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
] as const;

/** Reduces the daemon environment to the child-process allowlist. */
export function allowlistedEnvironment(
  parent: NodeJS.ProcessEnv,
  supplied: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_ENVIRONMENT) {
    const value = parent[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.PYTHONIOENCODING ??= "utf-8";
  environment.PYTHONUTF8 ??= "1";
  return { NODE_ENV: parent.NODE_ENV, ...environment, ...supplied };
}
