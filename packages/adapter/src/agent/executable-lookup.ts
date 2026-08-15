import { existsSync } from "node:fs";
import path from "node:path";

/** Windows' documented default when `PATHEXT` is absent from the environment. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolves a bare command name to an absolute executable path, or `null` when it
 * is not installed.
 *
 * This exists because node-pty does its own PATH walk on Windows and looks for
 * the literal filename — `PATHEXT` is never applied — so `codex` is searched
 * for as a file named exactly `codex` and never matches `codex.exe`. The
 * failure surfaces as `File not found:` with an empty path, which reads like a
 * bug in the caller rather than a missing extension.
 */
export function resolveExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const named = command.includes("/") || command.includes("\\");
  if (named) return existsSync(command) ? command : null;
  return searchPath(command, environment, platform === "win32");
}

/** Characters `cmd.exe` reads as syntax rather than as part of an argument. */
const CMD_METACHARACTERS = /[&|<>^()]/u;

/**
 * The command and arguments that start one agent with a UTF-8 console.
 *
 * On Windows the agent is launched *through* `cmd.exe` purely to run `chcp
 * 65001` first, and that is not a preference. Measured on a machine whose
 * console code page is 932: a Vietnamese line sent to the pane reached Codex as
 * `Ch?o b?n`, because an application in virtual-terminal input mode receives
 * keys that ConPTY encoded through the console input code page, and 932 cannot
 * represent those characters. Setting the page first makes the same line arrive
 * as `Chào bạn`. Neither `useConptyDll` nor the winpty backend changes it —
 * both were tried and both still lost the diacritics.
 *
 * Only paths are quoted, and only when they contain a character `cmd` would
 * read as syntax. A Windows account named `A&B` puts an ampersand in the middle
 * of every app-data path, and an unquoted one would end the command there.
 * Everything else this passes — flag names, a loopback URL, a TOML assignment —
 * contains no such character, and nothing typed by the user or the agent ever
 * reaches this command line: the terminal's text goes over stdin.
 */
export function consoleLaunchPlan(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform !== "win32") return { command: executable, args: [...args] };
  return {
    command: environment.COMSPEC ?? "cmd.exe",
    args: [
      "/d", "/c", "chcp", "65001", ">nul", "&",
      ...[executable, ...args].map(cmdArgument),
    ],
  };
}

function cmdArgument(value: string): string {
  return CMD_METACHARACTERS.test(value) ? `"${value}"` : value;
}

function endsWithExtension(command: string, extension: string): boolean {
  return command.toLowerCase().endsWith(extension.toLowerCase());
}

function searchPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  onWindows: boolean,
): string | null {
  // `Path`, not just `PATH`: Windows environment blocks are case-insensitive and
  // a copied environment can carry either spelling, so reading one name only
  // finds nothing on the machines that spell it the other way.
  const search = environment.PATH ?? environment.Path ?? "";
  const known = (environment.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean);
  // A name that already carries an executable extension is searched for as
  // written. Appending anyway turns `cmd.exe` into `cmd.exe.EXE`, which matches
  // nothing — the resolver then reports a command every Windows machine has as
  // not installed.
  const extensions = !onWindows || known.some((extension) => endsWithExtension(command, extension))
    ? [""]
    : known;
  for (const directory of search.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
