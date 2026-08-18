export function fileVersionMap(
  files: readonly { path: string; version: string }[],
): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.version]));
}
