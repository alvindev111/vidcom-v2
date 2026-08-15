import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/** Writes a real executable whose `--version` output has Chromium's shape. */
export async function createChromiumExecutable(
  root: string,
  name = "chromium-fixture",
  version = "Chromium 128.0.0.0",
): Promise<string> {
  const target = path.join(root, process.platform === "win32" ? `${name}.exe` : name);
  if (process.platform === "win32") {
    const source = [
      "using System;",
      "public static class ChromiumFixture {",
      "  public static int Main(string[] args) {",
      `    Console.WriteLine(${JSON.stringify(version)});`,
      "    return 0;",
      "  }",
      "}",
    ].join("\n");
    const command = [
      `$source = ${powershellLiteral(source)}`,
      `Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly ${powershellLiteral(target)} -OutputType ConsoleApplication`,
    ].join("\n");
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ], { encoding: "utf8", windowsHide: true });
    return target;
  }

  const escaped = version.replace(/'/gu, `'"'"'`);
  await writeFile(target, `#!/bin/sh\nprintf '%s\\n' '${escaped}'\n`, "utf8");
  await chmod(target, 0o755);
  return target;
}
